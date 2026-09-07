/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The fixed-function pipeline, written out as a shader.
 *
 * WebGPU has no fixed function at all, so the state a program sets with
 * individual calls has to become source code. Generating it per state
 * combination rather than writing one shader with branches is the cheaper of
 * the two at run time and, more importantly, the one where a combination that
 * does not compile says so -- a branch nobody took is a branch nobody checked.
 *
 * Three things here are decisions rather than transcription, and each is the
 * kind that produces a picture rather than an error when wrong:
 *
 * - **A pre-transformed vertex is not transformed.** XYZRHW means the program
 *   already did the projection and is handing over screen coordinates. They go
 *   through the viewport's inverse offset and scale instead, which is the
 *   second half of the viewport contract and the only thing that puts such a
 *   vertex on the pixel it names.
 * - **A vertex colour arrives with its channels exchanged.** D3DCOLOR is one
 *   DWORD of B,G,R,A bytes and `unorm8x4` reads them in that order, so every
 *   colour read from a vertex is swizzled back here. Missed, the picture is
 *   correct in every respect except that red and blue are exchanged.
 * - **A stage that is off is absent, not neutral.** The cascade below emits
 *   nothing for an empty stage list, and the fragment colour is then the
 *   interpolated diffuse. Emitting a "neutral" stage instead would multiply by
 *   an identity that is only an identity for some operations.
 */

/** D3DTOP, the colour and alpha operations a stage can name. */
export const D3DTOP = Object.freeze({
    DISABLE: 1,
    SELECTARG1: 2,
    SELECTARG2: 3,
    MODULATE: 4,
    MODULATE2X: 5,
    MODULATE4X: 6,
    ADD: 7,
    ADDSIGNED: 8,
    SUBTRACT: 10,
});

/** D3DTA, where a stage argument comes from. The low three bits select. */
export const D3DTA = Object.freeze({
    DIFFUSE: 0,
    CURRENT: 1,
    TEXTURE: 2,
    TFACTOR: 3,
    SPECULAR: 4,
    SELECTMASK: 0x7,
    COMPLEMENT: 0x10,
    ALPHAREPLICATE: 0x20,
});

/** D3DFOG. */
export const D3DFOG = Object.freeze({ NONE: 0, EXP: 1, EXP2: 2, LINEAR: 3 });

/**
 * The WGSL expression for one stage argument.
 *
 * @param {number} arg @param {number} stageIndex @returns {string}
 */
function argument(arg, stageIndex){
    const source = {
        [D3DTA.DIFFUSE]: 'input.diffuse',
        [D3DTA.CURRENT]: 'current',
        [D3DTA.TEXTURE]: `textureSample(texture${stageIndex}, sampler${stageIndex}, `
            + `input.texCoord${stageIndex})`,
        [D3DTA.TFACTOR]: 'uniforms.textureFactor',
        [D3DTA.SPECULAR]: 'input.specular',
    }[arg & D3DTA.SELECTMASK];

    if (source === undefined)
    {
        throw new Error(`Unsupported texture argument 0x${arg.toString(16)}`);
    }
    // Both modifiers wrap the value rather than replacing it, and they compose,
    // so they are applied in the order the API defines: replicate then invert.
    const replicated = (arg & D3DTA.ALPHAREPLICATE) !== 0 ? `vec4f((${source}).a)` : source;
    return (arg & D3DTA.COMPLEMENT) !== 0
        ? `(vec4f(1.0) - (${replicated}))`
        : replicated;
}

/**
 * The WGSL expression combining two arguments under one operation.
 *
 * @param {number} op @param {string} a @param {string} b @returns {string | null}
 */
function combine(op, a, b){
    switch (op)
    {
        case D3DTOP.DISABLE:
            return null;
        case D3DTOP.SELECTARG1:
            return a;
        case D3DTOP.SELECTARG2:
            return b;
        case D3DTOP.MODULATE:
            return `${a} * ${b}`;
        case D3DTOP.MODULATE2X:
            return `${a} * ${b} * 2.0`;
        case D3DTOP.MODULATE4X:
            return `${a} * ${b} * 4.0`;
        case D3DTOP.ADD:
            return `${a} + ${b}`;
        case D3DTOP.ADDSIGNED:
            return `${a} + ${b} - vec4f(0.5)`;
        case D3DTOP.SUBTRACT:
            return `${a} - ${b}`;
        default:
            throw new Error(`Unsupported texture operation ${op}`);
    }
}

/**
 * @param {import('./pipeline.js').PipelineState} state
 * @param {import('./vertexformat.js').VertexLayout} layout
 * @returns {{ code: string, label: string, textureCount: number }}
 */
export function generateFixedFunction(state, layout){
    const has = (/** @type {string} */ name)=>
        layout.attributes.some(attribute=>attribute.name === name);

    /** @type {string[]} */
    const varyings = [];
    /** @type {string[]} */
    const assignments = [];
    let location = 0;

    // A colour the vertex did not carry is opaque white, so a modulate against
    // it is an identity. That is the documented default and it matters: the
    // alternative, black, multiplies the scene away.
    varyings.push(`    @location(${location++}) diffuse: vec4f,`);
    assignments.push(has('diffuse')
        // The swizzle back from B,G,R,A. See the header.
        ? '    out.diffuse = vertex.diffuse.bgra;'
        : '    out.diffuse = vec4f(1.0, 1.0, 1.0, 1.0);');

    varyings.push(`    @location(${location++}) specular: vec4f,`);
    assignments.push(has('specular')
        ? '    out.specular = vertex.specular.bgra;'
        : '    out.specular = vec4f(0.0, 0.0, 0.0, 0.0);');

    for (let set = 0; set < layout.texCoordSets; set++)
    {
        varyings.push(`    @location(${location++}) texCoord${set}: vec2f,`);
        assignments.push(`    out.texCoord${set} = vertex.texCoord${set}.xy;`);
    }

    const inputs = layout.attributes
        .map(attribute=>`    @location(${attribute.shaderLocation}) `
            + `${attribute.name}: ${wgslType(attribute.format)},`)
        .join('\n');

    // Pre-transformed vertices skip the matrices entirely and go through the
    // viewport's inverse offset and scale, which is what lands them on the
    // pixel they name.
    const position = layout.preTransformed
        ? '    let screen = (vertex.position.xy + uniforms.viewportOffset) '
            + '* uniforms.viewportScale;\n'
            + '    out.position = vec4f(screen.x - 1.0, screen.y + 1.0, '
            + 'vertex.position.z, 1.0);'
        : '    out.position = uniforms.worldViewProjection * vec4f(vertex.position, 1.0);';

    const stages = state.stages.length === 0
        ? '    var current = input.diffuse;'
        : ['    var current = input.diffuse;', ...state.stages.map((stage, index)=>{
            const color = combine(stage.colorOp,
                argument(stage.colorArg1, index), argument(stage.colorArg2, index));
            if (color === null)
            {
                return `    // stage ${index} disabled`;
            }
            const alpha = combine(stage.alphaOp,
                argument(stage.alphaArg1, index), argument(stage.alphaArg2, index));
            return `    current = vec4f((${color}).rgb, `
                + `${alpha === null ? '(current).a' : `(${alpha}).a`});`;
        })].join('\n');

    const fog = state.fogMode === D3DFOG.NONE
        ? ''
        : '\n    let fogAmount = clamp(uniforms.fogFactors.x, 0.0, 1.0);'
            + '\n    current = vec4f(mix(uniforms.fogColor.rgb, current.rgb, fogAmount),'
            + ' current.a);';

    // The test discards rather than returning a transparent pixel: a discarded
    // fragment writes no depth, and one blended to zero alpha still does, which
    // is the difference between an alpha-tested fence and a fence-shaped hole
    // in everything drawn after it.
    const alphaTest = state.alphaTest
        ? `\n    if (!(${compareExpression(state.alphaFunc, 'current.a', 'uniforms.alphaRef')}))`
            + '\n    {\n        discard;\n    }'
        : '';

    const code = `struct Uniforms {
    worldViewProjection: mat4x4f,
    viewportOffset: vec2f,
    viewportScale: vec2f,
    textureFactor: vec4f,
    fogColor: vec4f,
    fogFactors: vec4f,
    alphaRef: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
${samplerDeclarations(state.stages.length)}
struct VertexIn {
${inputs}
};

struct VertexOut {
    @builtin(position) position: vec4f,
${varyings.join('\n')}
};

@vertex
fn vertexMain(vertex: VertexIn) -> VertexOut {
    var out: VertexOut;
${position}
${assignments.join('\n')}
    return out;
}

@fragment
fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
${stages}${fog}${alphaTest}
    return current;
}
`;

    return {
        code,
        label: `fixed-function:${state.fvf.toString(16)}:${state.stages.length}`,
        textureCount: state.stages.length,
    };
}

/**
 * Texture and sampler bindings, one pair per stage, from binding 1 upward.
 *
 * @param {number} count @returns {string}
 */
function samplerDeclarations(count){
    /** @type {string[]} */
    const lines = [];
    for (let index = 0; index < count; index++)
    {
        lines.push(`@group(0) @binding(${1 + index * 2}) var texture${index}: texture_2d<f32>;`);
        lines.push(`@group(0) @binding(${2 + index * 2}) var sampler${index}: sampler;`);
    }
    return lines.join('\n');
}

/** @param {number} func @param {string} value @param {string} reference */
function compareExpression(func, value, reference){
    const operator = {
        1: null, 2: '<', 3: '==', 4: '<=', 5: '>', 6: '!=', 7: '>=', 8: null,
    }[func];
    if (func === 1)
    {
        return 'false';
    }
    if (func === 8)
    {
        return 'true';
    }
    if (operator === null || operator === undefined)
    {
        throw new Error(`Unsupported alpha comparison ${func}`);
    }
    return `${value} ${operator} ${reference}`;
}

/** @param {string} format a WebGPU vertex format @returns {string} its WGSL type */
function wgslType(format){
    if (format === 'unorm8x4')
    {
        return 'vec4f';
    }
    if (format === 'float32')
    {
        return 'f32';
    }
    const width = Number(format.slice('float32x'.length));
    return `vec${width}f`;
}
