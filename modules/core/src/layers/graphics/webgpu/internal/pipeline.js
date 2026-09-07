/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Render state, turned into a pipeline.
 *
 * A Direct3D device sets state one value at a time and then draws; WebGPU wants
 * all of it decided in advance, baked into an immutable pipeline. So every draw
 * asks this for the pipeline its current state describes, and the answer has to
 * be cached or the frame builds hundreds of identical ones.
 *
 * Which makes the cache key the load-bearing part of this file. A key that
 * folds less than the pipeline actually depends on hands two draws that differ
 * one pipeline, and the second draw renders -- with the first draw's blend
 * mode, or its depth test, or its shader. Nothing reports it. The rule is that
 * every field this file reads on the way to building a descriptor is a field
 * the key folds, and the two are written next to each other so that adding one
 * without the other is visible.
 *
 * The texture-stage cascade deserves its own note. The fragment formula depends
 * on more than stage zero: a second stage arms a different combination, and a
 * texture coordinate index other than the obvious one selects different
 * coordinates. A key built from stage zero and a count collides across draws
 * that differ in both. So stages are folded individually, and the default is
 * expressible as *off* rather than as stage zero's value -- otherwise "no
 * stages" and "one default stage" produce the same key and are not the same
 * picture.
 */

/** D3DCMP → WebGPU's compare function. One is the identity of the other. */
const COMPARE = Object.freeze({
    1: 'never',
    2: 'less',
    3: 'equal',
    4: 'less-equal',
    5: 'greater',
    6: 'not-equal',
    7: 'greater-equal',
    8: 'always',
});

/**
 * D3DBLEND → WebGPU's blend factor.
 *
 * Two have no counterpart and are not silently approximated. BOTHSRCALPHA sets
 * the source *and* destination factor from one value, which is a pair of
 * factors rather than a factor, and BOTHINVSRCALPHA likewise; a caller has to
 * expand them before it gets here, and one that does not is told.
 */
const BLEND_FACTOR = Object.freeze({
    1: 'zero',
    2: 'one',
    3: 'src',
    4: 'one-minus-src',
    5: 'src-alpha',
    6: 'one-minus-src-alpha',
    7: 'dst-alpha',
    8: 'one-minus-dst-alpha',
    9: 'dst',
    10: 'one-minus-dst',
    11: 'src-alpha-saturated',
    14: 'constant',
    15: 'one-minus-constant',
});

/** D3DBLENDOP → WebGPU's blend operation. */
const BLEND_OP = Object.freeze({
    1: 'add',
    2: 'subtract',
    3: 'reverse-subtract',
    4: 'min',
    5: 'max',
});

/**
 * D3DCULL → WebGPU's cull face.
 *
 * Direct3D names the winding it discards and WebGPU names the face it culls,
 * with front faces counter-clockwise unless told otherwise. Getting this
 * backwards turns a model inside out, which reads as geometry vanishing when
 * the camera moves rather than as anything obviously wrong with culling.
 */
const CULL = Object.freeze({ 1: 'none', 2: 'front', 3: 'back' });

/** @param {Record<number, string>} table @param {number} value @param {string} what */
function lookUp(table, value, what){
    const found = table[value];
    if (found === undefined)
    {
        throw new Error(`Unsupported ${what}: ${value}`);
    }
    return found;
}

/**
 * A texture stage, reduced to what the fragment formula depends on.
 *
 * Anything a stage carries that the formula does not read is deliberately not
 * here: it would widen the key and split pipelines that draw identically.
 *
 * @typedef {Object} StageKey
 * @property {number} colorOp
 * @property {number} colorArg1
 * @property {number} colorArg2
 * @property {number} alphaOp
 * @property {number} alphaArg1
 * @property {number} alphaArg2
 * @property {number} texCoordIndex
 */

/**
 * Everything a pipeline depends on. Every field here is folded into the key.
 *
 * @typedef {Object} PipelineState
 * @property {number} fvf                 Zero when a vertex shader is bound.
 * @property {number} vertexShader        Handle, or zero for fixed function.
 * @property {number} pixelShader         Handle, or zero for fixed function.
 * @property {string} targetFormat
 * @property {string} [depthFormat]       Absent when there is no depth target.
 * @property {number} [sampleCount]
 * @property {string} [topology]
 * @property {boolean} depthTest
 * @property {boolean} depthWrite
 * @property {number} depthFunc
 * @property {number} cullMode
 * @property {boolean} blend
 * @property {number} srcBlend
 * @property {number} destBlend
 * @property {number} blendOp
 * @property {number} colorWrite         D3DCOLORWRITEENABLE bits.
 * @property {boolean} alphaTest
 * @property {number} alphaFunc
 * @property {number} fogMode            D3DFOG; NONE is 0.
 * @property {StageKey[]} stages         Empty means no cascade at all.
 */

/**
 * The key a pipeline is cached under.
 *
 * A string rather than a structure because it is compared by value on every
 * draw, and because a mismatch is far easier to read in a diagnostic than two
 * object graphs are.
 *
 * @param {PipelineState} state
 * @returns {string}
 */
export function pipelineKey(state){
    // Stages are joined with a separator that cannot occur inside one, so two
    // different stage lists cannot flatten to the same string.
    const stages = state.stages
        .map(stage=>[
            stage.colorOp, stage.colorArg1, stage.colorArg2,
            stage.alphaOp, stage.alphaArg1, stage.alphaArg2,
            stage.texCoordIndex,
        ].join(','))
        .join(';');

    return [
        state.fvf,
        state.vertexShader,
        state.pixelShader,
        state.targetFormat,
        state.depthFormat === undefined ? '-' : state.depthFormat,
        state.sampleCount === undefined ? 1 : state.sampleCount,
        state.topology === undefined ? 'triangle-list' : state.topology,
        state.depthTest ? 1 : 0,
        state.depthWrite ? 1 : 0,
        state.depthFunc,
        state.cullMode,
        state.blend ? 1 : 0,
        state.srcBlend,
        state.destBlend,
        state.blendOp,
        state.colorWrite,
        state.alphaTest ? 1 : 0,
        state.alphaFunc,
        state.fogMode,
        // The separator is what keeps two stage lists apart; the count in front
        // is for reading a key in a diagnostic, not for correctness. Said
        // plainly because the first version of this comment claimed the count
        // prevented a collision, and a mutation showed it prevents none: with
        // the count removed every test still passed.
        `${state.stages.length}[${stages}]`,
    ].join('|');
}

/**
 * D3DCOLORWRITEENABLE bits → a WebGPU colour write mask.
 *
 * The bit order is red, green, blue, alpha from bit zero, and it happens to
 * match WebGPU's; it is restated rather than passed through because "happens to
 * match" is not something the next reader can check without looking both up.
 *
 * @param {number} bits
 * @returns {number}
 */
export function colorWriteMask(bits){
    return (bits & 1 ? 1 : 0) | (bits & 2 ? 2 : 0) | (bits & 4 ? 4 : 0) | (bits & 8 ? 8 : 0);
}

/**
 * The descriptor for the state, less the shader modules and layout, which the
 * caller supplies because it owns compilation and binding.
 *
 * @param {PipelineState} state
 * @param {import('./vertexformat.js').VertexLayout | null} layout
 * @returns {any}
 */
export function pipelineDescriptor(state, layout){
    const depth = state.depthFormat === undefined
        ? undefined
        : {
            format: state.depthFormat,
            // A depth test that is off is expressed as always-passing rather
            // than by dropping the attachment: the target is still there, and a
            // later draw in the same pass may want to test against it.
            depthCompare: state.depthTest
                ? lookUp(COMPARE, state.depthFunc, 'depth function')
                : 'always',
            depthWriteEnabled: state.depthWrite,
        };

    const blend = state.blend
        ? {
            color: {
                srcFactor: lookUp(BLEND_FACTOR, state.srcBlend, 'source blend'),
                dstFactor: lookUp(BLEND_FACTOR, state.destBlend, 'destination blend'),
                operation: lookUp(BLEND_OP, state.blendOp, 'blend operation'),
            },
            alpha: {
                srcFactor: lookUp(BLEND_FACTOR, state.srcBlend, 'source blend'),
                dstFactor: lookUp(BLEND_FACTOR, state.destBlend, 'destination blend'),
                operation: lookUp(BLEND_OP, state.blendOp, 'blend operation'),
            },
        }
        : undefined;

    return {
        primitive: {
            topology: state.topology === undefined ? 'triangle-list' : state.topology,
            cullMode: lookUp(CULL, state.cullMode, 'cull mode'),
            frontFace: 'ccw',
        },
        depthStencil: depth,
        multisample: { count: state.sampleCount === undefined ? 1 : state.sampleCount },
        vertexLayout: layout === null
            ? undefined
            : {
                arrayStride: layout.stride,
                stepMode: 'vertex',
                attributes: layout.attributes.map(attribute=>({
                    shaderLocation: attribute.shaderLocation,
                    offset: attribute.offset,
                    format: attribute.format,
                })),
            },
        target: {
            format: state.targetFormat,
            blend,
            writeMask: colorWriteMask(state.colorWrite),
        },
    };
}

/**
 * A cache of pipelines, keyed by the state they were built from.
 *
 * Building is asynchronous because compiling a shader is, and two draws with
 * the same state in one frame must not build twice -- so a build in flight is
 * cached, not just a finished one.
 *
 * @param {{ build: (state: PipelineState, key: string) => Promise<any> }} options
 * @returns {any}
 */
export function createPipelineCache(options){
    /** @type {Map<string, Promise<any>>} */
    const pipelines = new Map();
    let built = 0;
    let reused = 0;

    return {
        /** @param {PipelineState} state @returns {Promise<any>} */
        get(state){
            const key = pipelineKey(state);
            const existing = pipelines.get(key);
            if (existing)
            {
                reused++;
                return existing;
            }
            built++;
            const building = options.build(state, key);
            pipelines.set(key, building);
            return building;
        },

        stats: ()=>({ built, reused, resident: pipelines.size }),

        clear(){
            pipelines.clear();
        },
    };
}
