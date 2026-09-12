/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
 *
 * Lighting is the fourth, and it is the one with a whole equation behind it.
 * It runs per vertex, in world space, and it is unrolled: one block of source
 * per enabled light, its type decided at generation time. What the light *is*
 * -- colour, position, cone -- stays in uniforms, so a light that moves does
 * not compile anything. Three points there are specification rather than
 * preference, and each is silent when wrong:
 *
 * - **The vertex colour selects a term, it does not modulate it.** With
 *   D3DRS_COLORVERTEX on, a material source of COLOR1 or COLOR2 takes the
 *   vertex's own colour *instead of* the material's -- and only if the vertex
 *   actually carries one, which is why the layout is consulted and not just
 *   the render state.
 * - **The specular term is a second colour, added after the texture cascade.**
 *   Not multiplied into the diffuse and not run through the stages: a
 *   highlight is light reflected off the surface rather than light passing
 *   through its texture.
 * - **The alpha of a lit vertex comes from the diffuse source alone.** The
 *   lighting equation is over the three colour channels only, and an alpha
 *   that picked up ambient or diffuse light would make lit geometry fade.
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

/**
 * The coordinate set D3DTSS_TEXCOORDINDEX names. The bits above it are the
 * D3DTSS_TCI_ generation modes, which this engine does not compute.
 */
export const COORD_SET_MASK = 0xffff;

/** D3DFOG. */
export const D3DFOG = Object.freeze({ NONE: 0, EXP: 1, EXP2: 2, LINEAR: 3 });

/** D3DMCS, where one lighting term takes its colour from. */
export const D3DMCS = Object.freeze({ MATERIAL: 0, COLOR1: 1, COLOR2: 2 });

/** D3DLIGHTTYPE. */
export const D3DLIGHT = Object.freeze({ POINT: 1, SPOT: 2, DIRECTIONAL: 3 });

/**
 * One light, as the uniform block carries it.
 *
 * Every row is a vec4f so that the block's layout is the same arithmetic in
 * WGSL and in the JavaScript that fills it: a uniform array's stride has to be
 * a multiple of sixteen bytes, and a three-float row followed by a scalar is
 * only accidentally that.
 *
 * `position.w` is the range and `spot` carries the cosines of the half-angles
 * rather than the angles: both are constant per light, and computing them once
 * on the processor keeps a transcendental out of every vertex.
 */
const LIGHT_STRUCT = `struct Light {
    diffuse: vec4f,
    specular: vec4f,
    ambient: vec4f,
    position: vec4f,
    direction: vec4f,
    attenuation: vec4f,
    spot: vec4f,
};
`;

/**
 * How much of the fragment's own colour survives, by distance.
 *
 * One for "fully visible" and zero for "entirely fog", which is the direction
 * Direct3D defines and the direction the mix below expects. Linear fog is the
 * only mode with an end: the two exponential ones fade for ever and reach zero
 * only in the limit.
 */
const FOG_FUNCTIONS = Object.freeze({
    [D3DFOG.LINEAR]: `fn fogFactorOf(dist: f32) -> f32 {
    let start = uniforms.fogFactors.x;
    let end = uniforms.fogFactors.y;
    // A range of nothing is a program asking for a step at that distance, not
    // a division by zero that erases the frame.
    if (end <= start)
    {
        return select(1.0, 0.0, dist >= end);
    }
    return clamp((end - dist) / (end - start), 0.0, 1.0);
}
`,
    [D3DFOG.EXP]: `fn fogFactorOf(dist: f32) -> f32 {
    return clamp(exp(-uniforms.fogFactors.z * dist), 0.0, 1.0);
}
`,
    [D3DFOG.EXP2]: `fn fogFactorOf(dist: f32) -> f32 {
    let scaled = uniforms.fogFactors.z * dist;
    return clamp(exp(-scaled * scaled), 0.0, 1.0);
}
`,
});

/**
 * Distance attenuation, which a directional light does not have and the other
 * two share.
 *
 * Past the range a light contributes nothing at all -- that is the range's
 * whole meaning, and without the test a distant light still adds its
 * attenuated remainder to every vertex in the scene.
 */
const ATTENUATION_FUNCTION = `fn attenuationOf(light: Light, dist: f32) -> f32 {
    if (dist > light.position.w)
    {
        return 0.0;
    }
    let denominator = light.attenuation.x + light.attenuation.y * dist
        + light.attenuation.z * dist * dist;
    // Every coefficient zero is a light with no falloff term to apply. The
    // division would otherwise hand the scene an infinity, which saturates to
    // white everywhere rather than failing.
    if (denominator <= 0.0)
    {
        return 1.0;
    }
    return 1.0 / denominator;
}
`;

/**
 * The spotlight cone: full brightness inside the inner cone, nothing outside
 * the outer one, and the falloff exponent between them.
 */
const SPOT_FUNCTION = `fn spotFactor(light: Light, toLight: vec3f) -> f32 {
    let rho = dot(light.direction.xyz, -toLight);
    if (rho > light.spot.x)
    {
        return 1.0;
    }
    if (rho <= light.spot.y)
    {
        return 0.0;
    }
    return pow((rho - light.spot.y) / (light.spot.x - light.spot.y), light.spot.z);
}
`;

/**
 * Which of an operation's two argument slots it reads.
 *
 * Stage state persists across draws, so a slot the operation does not read
 * holds whatever an unrelated draw left in it, and the API is explicit that
 * such a slot must not matter. Anything driven by the arguments -- which
 * textures a stage needs, above all -- has to ask the operation first.
 *
 * @param {number} op  D3DTOP
 * @param {number} arg1 @param {number} arg2
 * @returns {number[]} the argument values the operation actually reads
 */
export function argumentsRead(op, arg1, arg2){
    if (op === D3DTOP.DISABLE)
    {
        return [];
    }
    if (op === D3DTOP.SELECTARG1)
    {
        return [arg1];
    }
    if (op === D3DTOP.SELECTARG2)
    {
        return [arg2];
    }
    return [arg1, arg2];
}

/**
 * The WGSL expression for one stage argument.
 *
 * @param {number} arg
 * @param {number} stageIndex
 * @param {number} coordSet  which coordinate set this stage samples with
 * @returns {string}
 */
function argument(arg, stageIndex, coordSet){
    const source = {
        [D3DTA.DIFFUSE]: 'input.diffuse',
        [D3DTA.CURRENT]: 'current',
        [D3DTA.TEXTURE]: `sampleStage${stageIndex}(input.texCoord${coordSet})`,
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
 * The WGSL expression combining a stage's arguments under one operation.
 *
 * The slots the operation does not read are never turned into an expression at
 * all: a stale value there is allowed to be anything, including a source this
 * engine cannot spell, and building it would fail a draw over an argument
 * nothing consumes.
 *
 * @param {number} op
 * @param {number} stageIndex
 * @param {number} coordSet
 * @param {number} arg1 @param {number} arg2
 * @returns {string | null}
 */
function combine(op, stageIndex, coordSet, arg1, arg2){
    const read = argumentsRead(op, arg1, arg2);
    const a = read.length > 0 ? argument(read[0], stageIndex, coordSet) : '';
    const b = read.length > 1 ? argument(read[1], stageIndex, coordSet) : '';
    switch (op)
    {
        case D3DTOP.DISABLE:
            return null;
        case D3DTOP.SELECTARG1:
        case D3DTOP.SELECTARG2:
            return a;
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
 * Where one lighting term's colour comes from.
 *
 * A vertex colour is taken only when D3DRS_COLORVERTEX is on *and* the vertex
 * carries that colour; the material answers otherwise. Reading the render
 * state alone would sample an attribute the layout does not have, which is a
 * compile error at best and the wrong colour at worst.
 *
 * @param {import('./pipeline.js').LightingState} lighting
 * @param {(name: string)=>boolean} has
 * @param {number} source  D3DMCS
 * @param {string} material  the uniform holding the material's own colour
 * @returns {string}
 */
function termColour(lighting, has, source, material){
    if (lighting.colorVertex && source === D3DMCS.COLOR1 && has('diffuse'))
    {
        return 'vertex.diffuse.bgra';
    }
    if (lighting.colorVertex && source === D3DMCS.COLOR2 && has('specular'))
    {
        return 'vertex.specular.bgra';
    }
    return `uniforms.${material}`;
}

/**
 * One light's contribution, unrolled.
 *
 * @param {number} index
 * @param {number} type  D3DLIGHTTYPE
 * @param {boolean} specular  whether the specular term is computed at all
 * @returns {string}
 */
function lightContribution(index, type, specular){
    /** @type {string[]} */
    const lines = ['    {', `        let light = uniforms.lights[${index}];`];
    if (type === D3DLIGHT.DIRECTIONAL)
    {
        // D3DLIGHT8.Direction is the direction the light travels, so the
        // direction *towards* it -- which is what the equation wants -- is its
        // negation. A directional light neither attenuates nor falls off.
        lines.push('        let toLight = -light.direction.xyz;',
            '        let scale = 1.0;');
    }
    else if (type === D3DLIGHT.POINT || type === D3DLIGHT.SPOT)
    {
        lines.push(
            '        let offset = light.position.xyz - worldPosition;',
            '        let dist = length(offset);',
            // A vertex exactly at the light has no direction to be lit from,
            // and the guarded divisor turns that into no contribution rather
            // than into a not-a-number that erases the whole triangle.
            '        let toLight = offset / max(dist, 1e-8);',
            type === D3DLIGHT.SPOT
                ? '        let scale = attenuationOf(light, dist) * spotFactor(light, toLight);'
                : '        let scale = attenuationOf(light, dist);');
    }
    else
    {
        throw new Error(`Unsupported light type ${type}`);
    }
    lines.push(
        '        let ndotl = max(dot(worldNormal, toLight), 0.0);',
        '        lightAmbient += light.ambient.rgb * scale;',
        '        lightDiffuse += light.diffuse.rgb * (ndotl * scale);');
    if (specular)
    {
        lines.push(
            // The half vector, guarded the same way: a viewer exactly opposite
            // the light sums to zero and normalising that is a not-a-number.
            '        let halfway = toLight + toEye;',
            '        let halfNormal = halfway / max(length(halfway), 1e-8);',
            '        let highlight = pow(max(dot(worldNormal, halfNormal), 0.0), uniforms.eye.w);',
            '        lightSpecular += light.specular.rgb * (highlight * scale);');
    }
    lines.push('    }');
    return lines.join('\n');
}

/**
 * The vertex-shader body that lights a vertex, in place of copying its colours
 * through.
 *
 * Lighting is done in world space, so the normal is transformed by the world
 * matrix and renormalised. Renormalising is unconditional rather than following
 * D3DRS_NORMALIZENORMALS: that state exists to buy back the cost of the square
 * root, and skipping it is only correct when the world matrix has no scale --
 * where renormalising is a no-op anyway.
 *
 * Transforming a normal by the world matrix rather than by its inverse
 * transpose is what the fixed-function pipeline specifies; the two differ only
 * under non-uniform scale, and there the specification is the one to follow.
 *
 * @param {import('./pipeline.js').LightingState} lighting
 * @param {(name: string)=>boolean} has
 * @param {boolean} specular
 * @returns {string}
 */
function lightingBody(lighting, has, specular){
    // With no light enabled the specular sum is zero however it is written, and
    // emitting the terms anyway would leave the shader carrying an eye vector
    // and an accumulator nothing reads.
    const highlights = specular && lighting.lights.length > 0;
    /** @type {string[]} */
    const lines = [
        '    let worldPosition = (uniforms.world * vec4f(vertex.position, 1.0)).xyz;',
        '    let worldNormal = normalize((uniforms.world * vec4f(vertex.normal, 0.0)).xyz);',
    ];
    if (highlights)
    {
        lines.push('    let toEye = normalize(uniforms.eye.xyz - worldPosition);');
    }
    lines.push(
        '    var lightAmbient = vec3f(0.0, 0.0, 0.0);',
        '    var lightDiffuse = vec3f(0.0, 0.0, 0.0);');
    if (highlights)
    {
        lines.push('    var lightSpecular = vec3f(0.0, 0.0, 0.0);');
    }
    for (const [index, type] of lighting.lights.entries())
    {
        lines.push(lightContribution(index, type, highlights));
    }

    const diffuse = termColour(lighting, has, lighting.diffuseSource, 'materialDiffuse');
    const ambient = termColour(lighting, has, lighting.ambientSource, 'materialAmbient');
    const emissive = termColour(lighting, has, lighting.emissiveSource, 'materialEmissive');
    lines.push(
        `    let sourceDiffuse = ${diffuse};`,
        `    let sourceAmbient = ${ambient};`,
        `    let sourceEmissive = ${emissive};`,
        // The whole scene's ambient light and every light's own ambient reach
        // the vertex through the material's ambient colour, not around it.
        '    let lit = sourceEmissive.rgb'
            + ' + sourceAmbient.rgb * (uniforms.ambient.rgb + lightAmbient)'
            + ' + sourceDiffuse.rgb * lightDiffuse;',
        // The alpha is the diffuse source's, untouched by any of the above.
        '    out.diffuse = vec4f(clamp(lit, vec3f(0.0), vec3f(1.0)), sourceDiffuse.a);');
    if (highlights)
    {
        const specularSource =
            termColour(lighting, has, lighting.specularSource, 'materialSpecular');
        lines.push(
            `    let sourceSpecular = ${specularSource};`,
            '    out.specular = vec4f(clamp(sourceSpecular.rgb * lightSpecular,'
                + ' vec3f(0.0), vec3f(1.0)), 0.0);');
    }
    else
    {
        // A lit vertex with the specular term off has no highlight to carry,
        // and its own specular colour is not a substitute for one.
        lines.push('    out.specular = vec4f(0.0, 0.0, 0.0, 0.0);');
    }
    return lines.join('\n');
}

/**
 * @param {import('./pipeline.js').PipelineState} state
 * @param {import('./vertexformat.js').VertexLayout} layout
 * @returns {{ code: string, label: string, textureCount: number }}
 */
export function generateFixedFunction(state, layout){
    const has = (/** @type {string} */ name)=>
        layout.attributes.some(attribute=>attribute.name === name);
    const lighting = state.lighting ?? null;
    const specularEnable = state.specularEnable === true;
    if (lighting && !has('normal'))
    {
        throw new Error('A lit vertex format must carry a normal');
    }

    /** @type {string[]} */
    const varyings = [];
    /** @type {string[]} */
    const assignments = [];
    let location = 0;

    // A colour the vertex did not carry is opaque white, so a modulate against
    // it is an identity. That is the documented default and it matters: the
    // alternative, black, multiplies the scene away.
    varyings.push(`    @location(${location++}) diffuse: vec4f,`);
    varyings.push(`    @location(${location++}) specular: vec4f,`);
    if (lighting)
    {
        assignments.push(lightingBody(lighting, has, specularEnable));
    }
    else
    {
        assignments.push(has('diffuse')
            // The swizzle back from B,G,R,A. See the header.
            ? '    out.diffuse = vertex.diffuse.bgra;'
            : '    out.diffuse = vec4f(1.0, 1.0, 1.0, 1.0);');
        assignments.push(has('specular')
            ? '    out.specular = vertex.specular.bgra;'
            : '    out.specular = vec4f(0.0, 0.0, 0.0, 0.0);');
    }

    for (let set = 0; set < layout.texCoordSets; set++)
    {
        varyings.push(`    @location(${location++}) texCoord${set}: vec2f,`);
        assignments.push(`    out.texCoord${set} = vertex.texCoord${set}.xy;`);
    }

    if (state.fogMode !== D3DFOG.NONE)
    {
        varyings.push(`    @location(${location}) fogAmount: f32,`);
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

    // How much of the fragment survives the fog, computed per vertex and
    // interpolated across the triangle.
    //
    // The distance it fades by is the clip-space w, which for a perspective
    // projection is the eye-space depth -- the distance Direct3D's fog is
    // defined against. A pre-transformed vertex has no eye to be far from: it
    // is already on the screen, and Direct3D takes its fog factor straight
    // from the specular alpha the program supplied. Where such a format carries
    // no specular there is nothing to fog by, and inventing a distance would
    // fade a two-dimensional overlay by how deep the scene behind it happens
    // to be.
    //
    // Per vertex rather than per pixel, which is what D3DRS_FOGVERTEXMODE asks
    // for and an approximation of D3DRS_FOGTABLEMODE. The two differ only where
    // a triangle is large enough for the curve to bend across it, and the
    // interpolated factor is exact for linear fog either way.
    const fogAmount = state.fogMode === D3DFOG.NONE
        ? []
        : [layout.preTransformed
            ? `    out.fogAmount = ${has('specular') ? 'vertex.specular.a' : '1.0'};`
            : '    out.fogAmount = fogFactorOf(out.position.w);'];

    const stages = state.stages.length === 0
        ? '    var current = input.diffuse;'
        : ['    var current = input.diffuse;', ...state.stages.map((stage, index)=>{
            // The set the program bound, not the stage's own number: two stages
            // sharing one set is the ordinary way a detail or lightmap pass is
            // written, and reading set N for stage N samples a varying the
            // vertex never carried.
            const coordSet = stage.texCoordIndex & COORD_SET_MASK;
            const color = combine(
                stage.colorOp, index, coordSet, stage.colorArg1, stage.colorArg2);
            if (color === null)
            {
                return `    // stage ${index} disabled`;
            }
            const alpha = combine(
                stage.alphaOp, index, coordSet, stage.alphaArg1, stage.alphaArg2);
            return `    current = vec4f((${color}).rgb, `
                + `${alpha === null ? '(current).a' : `(${alpha}).a`});`;
        })].join('\n');

    // The specular colour is added after the cascade and before the fog, which
    // is where the fixed-function pipeline adds it: a highlight is light
    // reflected off the surface, not light that went through its texture.
    const specular = specularEnable
        ? '\n    current = vec4f(current.rgb + input.specular.rgb, current.a);'
        : '';

    const fog = state.fogMode === D3DFOG.NONE
        ? ''
        : '\n    current = vec4f(mix(uniforms.fogColor.rgb, current.rgb,'
            + ' clamp(input.fogAmount, 0.0, 1.0)), current.a);';

    // The test discards rather than returning a transparent pixel: a discarded
    // fragment writes no depth, and one blended to zero alpha still does, which
    // is the difference between an alpha-tested fence and a fence-shaped hole
    // in everything drawn after it.
    const alphaTest = state.alphaTest
        ? `\n    if (!(${compareExpression(state.alphaFunc, 'current.a', 'uniforms.alphaRef')}))`
            + '\n    {\n        discard;\n    }'
        : '';

    const lightCount = lighting === null ? 0 : lighting.lights.length;
    const code = `${lightCount === 0 ? '' : LIGHT_STRUCT}struct Uniforms {
    worldViewProjection: mat4x4f,
    world: mat4x4f,
    viewportOffset: vec2f,
    viewportScale: vec2f,
    textureFactor: vec4f,
    fogColor: vec4f,
    fogFactors: vec4f,
    materialDiffuse: vec4f,
    materialAmbient: vec4f,
    materialSpecular: vec4f,
    materialEmissive: vec4f,
    ambient: vec4f,
    eye: vec4f,
    alphaRef: f32,
    stage0: u32,
    stage1: u32,
    stage2: u32,
    texTransform: array<vec4f, 6>,${lightCount === 0 ? '' : `
    lights: array<Light, ${lightCount}>,`}
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
${functionDeclarations(lighting, state.fogMode)}${samplerDeclarations(state.stages.length)}
${sampleFunctions(state.stages.length)}
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
${[...assignments, ...fogAmount].join('\n')}
    return out;
}

@fragment
fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
${stages}${specular}${fog}${alphaTest}
    return current;
}
`;

    return {
        code,
        label: `fixed-function:${state.fvf.toString(16)}:${state.stages.length}`
            + (lighting === null ? '' : `:lit${lightCount}`),
        textureCount: state.stages.length,
    };
}

/**
 * The helper functions the light blocks call, and only those: a directional
 * light needs neither, and a shader carrying a function nothing calls is a
 * function nothing checked.
 *
 * @param {import('./pipeline.js').LightingState | null} lighting
 * @param {number} fogMode  D3DFOG; NONE is 0.
 * @returns {string}
 */
function functionDeclarations(lighting, fogMode){
    // Only for geometry that has a distance to fog by: a pre-transformed vertex
    // carries its factor already and would leave this declared and uncalled.
    const curves = /** @type {Record<number, string>} */ (FOG_FUNCTIONS);
    const fog = fogMode === D3DFOG.NONE ? '' : curves[fogMode] ?? '';
    if (lighting === null)
    {
        return fog;
    }
    const attenuates = lighting.lights.some(
        type=>type === D3DLIGHT.POINT || type === D3DLIGHT.SPOT);
    return fog
        + (attenuates ? ATTENUATION_FUNCTION : '')
        + (lighting.lights.includes(D3DLIGHT.SPOT) ? SPOT_FUNCTION : '');
}

/**
 * One coordinate under a Direct3D address mode, for the repeating sampler.
 *
 * Wrap is the sampler's own; mirror folds the coordinate; clamp holds it. A
 * folded or held coordinate is then kept inside the outermost texel centres,
 * because the sampler underneath repeats and would otherwise blend the edge
 * with the far side of the texture.
 */
const ADDRESS_FUNCTION = `fn addressCoordinate(t: f32, mode: u32, texels: f32) -> f32 {
    if (mode == 0u) {
        return t;
    }
    var folded = t;
    if (mode == 1u) {
        folded = 1.0 - abs(fract(t * 0.5) * 2.0 - 1.0);
    }
    let inset = 0.5 / max(texels, 1.0);
    return clamp(folded, inset, 1.0 - inset);
}
`;

/**
 * The sampling of one stage, with the stage's sampler state read from the
 * block: address modes, point filtering by snapping to texel centres, and the
 * mip mode as an explicit level. The derivatives are taken from the raw
 * coordinate first, in uniform control flow, whatever the mode then does.
 *
 * @param {number} count @returns {string}
 */
function sampleFunctions(count){
    if (count === 0)
    {
        return '';
    }
    /** @type {string[]} */
    const lines = [ADDRESS_FUNCTION];
    for (let index = 0; index < count; index++)
    {
        const flags = index < 3 ? `uniforms.stage${index}` : '0u';
        // The stage's texture transform, as Direct3D applies it to a
        // two-dimensional coordinate: (u, v, 1) through the first three rows,
        // so a translation is the third row and not the fourth. Identity rows
        // are carried for a stage without one, so the sample is one expression.
        const transformed = index < 3
            ? [
                '    let extended = vec3f(carried, 1.0);',
                `    let raw = vec2f(dot(uniforms.texTransform[${index * 2}].xyz, extended),`,
                `        dot(uniforms.texTransform[${index * 2 + 1}].xyz, extended));`,
                '',
            ].join('\n')
            : '    let raw = carried;\n';
        lines.push(`fn sampleStage${index}(carried: vec2f) -> vec4f {
${transformed}    let flags = ${flags};
    let size = vec2f(textureDimensions(texture${index}, 0));
    let dx = dpdx(raw * size);
    let dy = dpdy(raw * size);
    let levels = f32(textureNumLevels(texture${index}));
    let lod = clamp(0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1.0e-12)),
        f32((flags >> 8u) & 0xffu), max(levels - 1.0, 0.0));
    let mipMode = (flags >> 6u) & 3u;
    var level = 0.0;
    if (mipMode == 1u) {
        level = round(lod);
    } else if (mipMode == 2u) {
        level = lod;
    }
    let levelSize = max(floor(size / exp2(floor(level))), vec2f(1.0));
    var uv = vec2f(addressCoordinate(raw.x, flags & 3u, levelSize.x),
        addressCoordinate(raw.y, (flags >> 2u) & 3u, levelSize.y));
    var point = (flags >> 4u) & 1u;
    if (lod > 0.0) {
        point = (flags >> 5u) & 1u;
    }
    if (point == 1u) {
        uv = (floor(uv * levelSize) + 0.5) / levelSize;
    }
    return textureSampleLevel(texture${index}, sampler${index}, uv, level);
}
`);
    }
    return lines.join('\n');
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
