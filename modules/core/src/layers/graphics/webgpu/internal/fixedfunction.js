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

import { FOG_SOURCE, fogSourceOf } from './pipeline.js';

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
    ADDSIGNED2X: 9,
    SUBTRACT: 10,
    ADDSMOOTH: 11,
    BLENDDIFFUSEALPHA: 12,
    BLENDTEXTUREALPHA: 13,
    BLENDFACTORALPHA: 14,
    BLENDTEXTUREALPHAPM: 15,
    BLENDCURRENTALPHA: 16,
    MODULATEALPHA_ADDCOLOR: 18,
    MODULATECOLOR_ADDALPHA: 19,
    MODULATEINVALPHA_ADDCOLOR: 20,
    MODULATEINVCOLOR_ADDALPHA: 21,
    BUMPENVMAP: 22,
    BUMPENVMAPLUMINANCE: 23,
    DOTPRODUCT3: 24,
    MULTIPLYADD: 25,
    LERP: 26,
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
 * D3DTSS_TCI_ generation modes (`TCI`).
 */
export const COORD_SET_MASK = 0xffff;

/**
 * D3DTSS_TCI_*: a stage's coordinates computed from the vertex in camera
 * space rather than read from a set it carries. The set in the low bits is
 * then only where the result lands.
 */
export const TCI = Object.freeze({
    CAMERASPACENORMAL: 0x10000,
    CAMERASPACEPOSITION: 0x20000,
    CAMERASPACEREFLECTIONVECTOR: 0x30000,
    SPHEREMAP: 0x40000,
});

/** The generation mode of a D3DTSS_TEXCOORDINDEX value: zero for none. */
export const generationOf = (/** @type {number} */ texCoordIndex)=>texCoordIndex & ~COORD_SET_MASK;

/**
 * Whether the vertex stage computes a stage's coordinates: the three
 * camera-space modes. A sphere map is left to the set the vertex carries.
 */
export const generates = (/** @type {number} */ texCoordIndex)=>{
    const mode = generationOf(texCoordIndex);
    return mode === TCI.CAMERASPACENORMAL || mode === TCI.CAMERASPACEPOSITION
        || mode === TCI.CAMERASPACEREFLECTIONVECTOR;
};

/**
 * Whether a stage's generated coordinates are taken from the vertex normal:
 * the normal itself or the eye reflected about it.
 */
export const readsNormal = (/** @type {number} */ texCoordIndex)=>{
    const mode = generationOf(texCoordIndex);
    return mode === TCI.CAMERASPACENORMAL || mode === TCI.CAMERASPACEREFLECTIONVECTOR;
};

/**
 * The WGSL for one generated coordinate, from the camera-space position and
 * normal the vertex stage has in hand.
 *
 * @param {number} texCoordIndex @returns {string}
 */
export function generatedCoordinate(texCoordIndex){
    switch (generationOf(texCoordIndex))
    {
        case TCI.CAMERASPACENORMAL:
            return 'cameraNormal';
        case TCI.CAMERASPACEREFLECTIONVECTOR:
            return 'reflect(normalize(cameraPosition), cameraNormal)';
        default:
            return 'cameraPosition';
    }
}

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
 *
 * The row the three numbers live in is the caller's: the fixed-function block
 * keeps them in a row of its own, and a translated pixel shader keeps them in
 * the block its fog binding names, and both are this one formula.
 *
 * @param {number} mode  D3DFOG; NONE is 0, which declares nothing.
 * @param {string} [factors]  WGSL expression for the (start, end, density) row.
 * @param {boolean} [perVertex]  Evaluated at the vertices and interpolated.
 * @returns {string}
 */
export function fogFunctionDeclaration(mode, factors = 'uniforms.fogFactors', perVertex = false){
    switch (mode)
    {
        case D3DFOG.LINEAR:
            return `fn fogFactorOf(dist: f32) -> f32 {
    let start = ${factors}.x;
    let end = ${factors}.y;
    // A range of nothing is a program asking for a step at that distance, not
    // a division by zero that erases the frame -- per pixel. At the vertices
    // Windows fogs it whole (Wine's d3d8 fog_special_test): a step there would
    // interpolate into a gradient across every primitive that spans it.
    if (end <= start)
    {
        return ${perVertex ? '0.0' : 'select(1.0, 0.0, dist >= end)'};
    }
    return clamp((end - dist) / (end - start), 0.0, 1.0);
}
`;
        case D3DFOG.EXP:
            return `fn fogFactorOf(dist: f32) -> f32 {
    return clamp(exp(-${factors}.z * dist), 0.0, 1.0);
}
`;
        case D3DFOG.EXP2:
            return `fn fogFactorOf(dist: f32) -> f32 {
    let scaled = ${factors}.z * dist;
    return clamp(exp(-scaled * scaled), 0.0, 1.0);
}
`;
        default:
            return '';
    }
}

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
 * @param {number} [arg0]  ARG0, read by MULTIPLYADD and LERP
 * @returns {number[]} the argument values the operation actually reads
 */
export function argumentsRead(op, arg1, arg2, arg0 = /** @type {number} */ (D3DTA.CURRENT)){
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
    // The two three-operand operations read the stage's ARG0 as their third.
    if (op === D3DTOP.MULTIPLYADD || op === D3DTOP.LERP)
    {
        return [arg1, arg2, arg0];
    }
    return [arg1, arg2];
}

/**
 * The WGSL expression for one stage argument.
 *
 * @param {number} arg
 * @param {number} stageIndex
 * @param {string} coordinate  the expression this stage samples with
 * @param {string} [specular]  the expression the specular colour is read as
 * @param {string} [texture]  what this stage's texture reads as: its sample, or
 *     the sample a bump stage before it scaled
 * @returns {string}
 */
function argument(arg, stageIndex, coordinate, specular = 'input.specular',
    texture = `sampleStage${stageIndex}(${coordinate})`)
{
    const source = {
        [D3DTA.DIFFUSE]: 'input.diffuse',
        [D3DTA.CURRENT]: 'current',
        [D3DTA.TEXTURE]: texture,
        [D3DTA.TFACTOR]: 'uniforms.textureFactor',
        [D3DTA.SPECULAR]: specular,
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
 * @param {string} coordinate
 * @param {number} arg1 @param {number} arg2
 * @param {string} [specular]  as `argument` reads it
 * @param {number} [arg0]  the third operand of MULTIPLYADD and LERP
 * @param {string} [texture]  as `argument` reads it
 * @returns {string | null}
 */
function combine(op, stageIndex, coordinate, arg1, arg2, specular = 'input.specular', arg0 = 1,
    texture = `sampleStage${stageIndex}(${coordinate})`)
{
    const read = argumentsRead(op, arg1, arg2, arg0);
    const a = read.length > 0 ? argument(read[0], stageIndex, coordinate, specular, texture) : '';
    const b = read.length > 1 ? argument(read[1], stageIndex, coordinate, specular, texture) : '';
    const c = read.length > 2 ? argument(read[2], stageIndex, coordinate, specular, texture) : '';
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
        case D3DTOP.ADDSIGNED2X:
            return `(${a} + ${b} - vec4f(0.5)) * 2.0`;
        case D3DTOP.SUBTRACT:
            return `${a} - ${b}`;
        case D3DTOP.ADDSMOOTH:
            return `${a} + ${b} - ${a} * ${b}`;
        // The four blends: arg1 by an alpha, arg2 by its complement, the
        // alpha from the vertex, this stage's texture, the factor or the
        // running result. The premultiplied form adds arg1 unscaled.
        case D3DTOP.BLENDDIFFUSEALPHA:
            return `mix(${b}, ${a}, (input.diffuse).a)`;
        case D3DTOP.BLENDTEXTUREALPHA:
            return `mix(${b}, ${a}, (${texture}).a)`;
        case D3DTOP.BLENDFACTORALPHA:
            return `mix(${b}, ${a}, (uniforms.textureFactor).a)`;
        case D3DTOP.BLENDTEXTUREALPHAPM:
            return `${a} + ${b} * (1.0 - (${texture}).a)`;
        case D3DTOP.BLENDCURRENTALPHA:
            return `mix(${b}, ${a}, (current).a)`;
        // The four colour-only forms: one argument's alpha or colour scales the
        // other's colour, and the first argument's alpha or colour is added.
        case D3DTOP.MODULATEALPHA_ADDCOLOR:
            return `(${a}) + vec4f((${a}).a) * (${b})`;
        case D3DTOP.MODULATECOLOR_ADDALPHA:
            return `(${a}) * (${b}) + vec4f((${a}).a)`;
        case D3DTOP.MODULATEINVALPHA_ADDCOLOR:
            return `vec4f(1.0 - (${a}).a) * (${b}) + (${a})`;
        case D3DTOP.MODULATEINVCOLOR_ADDALPHA:
            return `(vec4f(1.0) - (${a})) * (${b}) + vec4f((${a}).a)`;
        // Both arguments as signed vectors, the dot product replicated into
        // every channel, alpha too.
        case D3DTOP.DOTPRODUCT3:
            return `vec4f(saturate(4.0 * dot((${a}).rgb - vec3f(0.5), (${b}).rgb - vec3f(0.5))))`;
        // The third argument (ARG0) is the one added, as it is the one LERP
        // takes its proportion from: ARG1 * ARG2 + ARG0.
        case D3DTOP.MULTIPLYADD:
            return `(${a}) * (${b}) + (${c})`;
        case D3DTOP.LERP:
            return `mix(${b}, ${a}, ${c})`;
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
            // Only a face the light reaches has a highlight: behind it, a
            // power of zero would light every vertex at full.
            '        let highlight = select(0.0,',
            '            pow(max(dot(worldNormal, halfNormal), 0.0), uniforms.eye.w),'
                + ' ndotl > 0.0);',
            '        lightSpecular += light.specular.rgb * (highlight * scale);');
    }
    lines.push('    }');
    return lines.join('\n');
}

/**
 * A transformed normal, renormalised when the program asked for it.
 *
 * @param {string} expression @param {boolean} normalizeNormals @returns {string}
 */
const normalized = (expression, normalizeNormals)=>
    (normalizeNormals ? `normalize(${expression})` : expression);

/**
 * The vertex-shader body that lights a vertex, in place of copying its colours
 * through.
 *
 * Lighting is done in world space, so the normal is transformed into it --
 * by the inverse transpose of the world matrix, which the block carries as
 * `normalMatrix`: the world matrix itself turns a normal aside under
 * non-uniform scale, and lights a surface under a non-affine world that
 * Direct3D leaves black. It is renormalised only under
 * D3DRS_NORMALIZENORMALS. Off -- its default -- a normal that arrives longer
 * or shorter than one, or is scaled by the transform, lights its vertex by
 * that length, which is what a program that leaves the state off is shown.
 *
 * @param {import('./pipeline.js').LightingState} lighting
 * @param {(name: string)=>boolean} has
 * @param {boolean} specular
 * @param {boolean} normalizeNormals  D3DRS_NORMALIZENORMALS.
 * @returns {string}
 */
function lightingBody(lighting, has, specular, normalizeNormals){
    // With no light enabled the specular sum is zero however it is written, and
    // emitting the terms anyway would leave the shader carrying an eye vector
    // and an accumulator nothing reads.
    const highlights = specular && lighting.lights.length > 0;
    /** @type {string[]} */
    const lines = [
        '    let worldPosition = (uniforms.world * vec4f(vertex.position, 1.0)).xyz;',
        // A vertex with no normal is lit with a zero one, as Direct3D lights
        // it: its lights add nothing, and ambient and emissive light it whole.
        `    let worldNormal = ${has('normal') ? normalized(
            '(uniforms.normalMatrix * vec4f(vertex.normal, 0.0)).xyz', normalizeNormals)
            : 'vec3f(0.0)'};`,
    ];
    if (highlights)
    {
        // D3DRS_LOCALVIEWER off puts the viewer at infinity: one direction
        // towards it for every vertex, carried in place of the eye.
        lines.push(lighting.localViewer === false
            ? '    let toEye = uniforms.eye.xyz;'
            : '    let toEye = normalize(uniforms.eye.xyz - worldPosition);');
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
    const normalizeNormals = state.normalizeNormals === true;
    /** @type {string[]} */
    const varyings = [];
    /** @type {string[]} */
    const assignments = [];
    let location = 0;

    // A colour the vertex did not carry is opaque white, so a modulate against
    // it is an identity. That is the documented default and it matters: the
    // alternative, black, multiplies the scene away.
    //
    // Flat shading takes both colours from the primitive's provoking vertex
    // -- its first, as Direct3D's is -- except the specular alpha, which
    // D3DSHADE_FLAT still interpolates, and which travels smooth beside them.
    const flat = state.flatShading === true;
    const interpolation = flat ? ' @interpolate(flat)' : '';
    varyings.push(`    @location(${location++})${interpolation} diffuse: vec4f,`);
    varyings.push(`    @location(${location++})${interpolation} specular: vec4f,`);
    if (flat)
    {
        varyings.push(`    @location(${location++}) specularAlpha: f32,`);
    }
    if (lighting)
    {
        assignments.push(lightingBody(lighting, has, specularEnable, normalizeNormals));
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

    if (flat)
    {
        assignments.push('    out.specularAlpha = out.specular.a;');
    }

    // A set a cube or volume stage reads carries all its components, zero
    // for one the vertex does not have; every other set carries two.
    const wide = wideSets(state);
    // A set a stage reads and the vertex does not carry is zero, as Direct3D
    // reads an absent one.
    const sets = state.stages.reduce((most, stage)=>(generates(stage.texCoordIndex) ? most
        : Math.max(most, (stage.texCoordIndex & COORD_SET_MASK) + 1)), layout.texCoordSets);
    for (let set = 0; set < sets; set++)
    {
        const format = layout.attributes.find(attribute=>attribute.name === `texCoord${set}`)
            ?.format ?? 'float32x2';
        const carried = set < layout.texCoordSets;
        varyings.push(
            `    @location(${location++}) texCoord${set}: ${wide.has(set) ? 'vec4f' : 'vec2f'},`);
        assignments.push(`    out.texCoord${set} = ${!carried
            ? wide.has(set) ? 'vec4f(0.0, 0.0, 0.0, 1.0)' : 'vec2f(0.0)'
            : wide.has(set) ? widened(`vertex.texCoord${set}`, format)
                : `vertex.texCoord${set}.xy`};`);
    }

    // A stage generating its coordinates from the vertex in camera space gets
    // a varying of its own, with the stage's texture transform applied here
    // as Direct3D applies it, in vertex processing, and not again at the
    // sample. A pre-transformed vertex has no camera space: it gets zero. The
    // normal goes there by the inverse transpose of world then view, as a lit
    // normal goes into world space by the world's.
    const generated = state.stages.map(stage=>generates(stage.texCoordIndex));
    if (generated.some(Boolean) && !layout.preTransformed)
    {
        assignments.push(
            '    let cameraPosition = (uniforms.worldView * vec4f(vertex.position, 1.0)).xyz;',
            `    let cameraNormal = ${has('normal')
                ? normalized('(uniforms.cameraNormalMatrix * vec4f(vertex.normal, 0.0)).xyz',
                    normalizeNormals)
                : 'vec3f(0.0, 0.0, 1.0)'};`);
    }
    for (const [index, stage] of state.stages.entries())
    {
        if (!generated[index])
        {
            continue;
        }
        varyings.push(`    @location(${location++}) generated${index}: vec4f,`);
        assignments.push(layout.preTransformed
            ? `    out.generated${index} = vec4f(0.0, 0.0, 1.0, 1.0);`
            : `    out.generated${index} = ${transformedGeneration(index,
                generatedCoordinate(stage.texCoordIndex))};`);
    }

    // A point drawn as a quad: this vertex is one of its six corners, moved
    // from the point's centre by half its size in pixels. The size is the
    // vertex's own or the state's; scaled, it falls off with the distance from
    // the eye by the three coefficients, in units of the viewport's height;
    // then it is held between the minimum and the maximum, the maximum
    // winning where the two cross.
    const points = state.points ?? null;
    /** @type {string[]} */
    const pointLines = [];
    if (points)
    {
        const base = has('pointSize') ? 'vertex.pointSize' : 'uniforms.point.x';
        const scaled = points.scale && !layout.preTransformed;
        pointLines.push(
            '    var pointCorners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0),',
            '        vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));',
            '    let pointCorner = pointCorners[corner];',
            ...(scaled ? [
                '    let pointDistance = length((uniforms.worldView'
                    + ' * vec4f(vertex.position, 1.0)).xyz);',
                '    let pointScaled = uniforms.pointScale.w * sqrt(1.0 / (uniforms.pointScale.x',
                '        + uniforms.pointScale.y * pointDistance',
                `        + uniforms.pointScale.z * pointDistance * pointDistance)) * ${base};`,
            ] : [`    let pointScaled = ${base};`]),
            '    let pointSize = min(max(pointScaled, uniforms.point.y), uniforms.point.z);',
            '    out.position = vec4f(out.position.xy + pointCorner * pointSize * 0.5',
            '        * uniforms.viewportScale * out.position.w, out.position.zw);');
        if (points.sprite)
        {
            varyings.push(`    @location(${location++}) sprite: vec2f,`);
            pointLines.push('    out.sprite = pointCorner * 0.5 + 0.5;');
        }
    }

    // Table fog is the pixel's own and needs no varying. Vertex fog on a
    // pre-transformed vertex is the program's, in its specular alpha.
    const fogSource = fogSourceOf(state);
    const vertexFog = fogSource === FOG_SOURCE.VERTEX && !layout.preTransformed;
    const carriedFog = fogSource === FOG_SOURCE.SPECULAR || fogSource === FOG_SOURCE.VERTEX;
    if (carriedFog)
    {
        varyings.push(`    @location(${location}) fogAmount: f32,`);
    }

    const inputs = layout.attributes
        .map(attribute=>`    @location(${attribute.shaderLocation}) `
            + `${attribute.name}: ${wgslType(attribute.format)},`)
        .join('\n');

    // Pre-transformed vertices skip the matrices entirely and go through the
    // viewport's inverse offset and scale, which is what lands them on the
    // pixel they name. Their RHW goes back in as the clip w, scaling the rest
    // with it so the divide gives the same point: it is what the rasteriser
    // interpolates by, and a w of one everywhere interpolates a perspective
    // quad affinely. An RHW of zero or less has no w to give and is taken as
    // one, as Windows still draws such a vertex.
    const position = layout.preTransformed
        ? '    let screen = (vertex.position.xy + uniforms.viewportOffset) '
            + '* uniforms.viewportScale;\n'
            + '    let clipW = select(1.0, 1.0 / vertex.position.w, vertex.position.w > 0.0);\n'
            + '    out.position = vec4f(screen.x - 1.0, screen.y + 1.0, '
            + 'vertex.position.z, 1.0) * clipW;'
        : '    out.position = uniforms.worldViewProjection * vec4f(vertex.position, 1.0);';
    // Direct3D puts a pixel's centre on its integer coordinate and WebGPU
    // half a pixel further on, so every position moves by half a pixel: half
    // the viewport's scale in clip space, times w. A quad drawn at pixel edges
    // covers the same pixels either way; what moves is where a sample and an
    // interpolated value are taken.
    const pixelCentre = '    out.position = vec4f(out.position.xy'
        + ' + out.position.w * uniforms.viewportScale * 0.5, out.position.zw);';

    // How much of the fragment survives vertex fog, interpolated across the
    // triangle. The distance is the magnitude of the camera-space z, not the
    // clip w: the two agree only under a perspective projection, and an
    // orthographic one has a w of one at every depth. Range fog takes the
    // camera-space distance from the eye instead. Where the factor is the
    // program's own, in the specular alpha, and the format carries no
    // specular, there is nothing to fog by, and inventing a distance would
    // fade a two-dimensional overlay by how deep the scene behind it happens
    // to be.
    const cameraPoint = '(uniforms.worldView * vec4f(vertex.position, 1.0))';
    const fogAmount = !carriedFog ? []
        : vertexFog
            ? [`    out.fogAmount = fogFactorOf(${state.rangeFog
                ? `length(${cameraPoint}.xyz)` : `abs(${cameraPoint}.z)`});`]
            : [`    out.fogAmount = ${has('specular') ? 'vertex.specular.a' : '1.0'};`];

    const lightCount = lighting === null ? 0 : lighting.lights.length;
    // A pre-transformed vertex is not clipped by its depth, and with no depth
    // test its depth is read by nothing else: held inside the range, it is
    // drawn wherever its z lies, as Direct3D draws it (Wine's d3d8
    // zenable_test), where the rasteriser would cut it at the near and far.
    const unclipped = layout.preTransformed && !state.depthTest
        ? '\n    out.position.z = clamp(out.position.z, 0.0, out.position.w);' : '';
    const cornerInput = points ? ', @builtin(vertex_index) corner: u32' : '';
    const keys = state.stages.map(stage=>stage.colorKey ?? null);
    // The position is @invariant: a second pass over the same geometry with
    // a different stage or light setup is a different module, and WGSL
    // promises two modules the same position from the same computation only
    // under the attribute -- which has no effect where the struct is the
    // fragment's input.
    const code = `${lightCount === 0 ? '' : LIGHT_STRUCT}${uniformStruct(lightCount)}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
${functionDeclarations(lighting, vertexFog || fogSource === FOG_SOURCE.TABLE
        ? state.fogMode : D3DFOG.NONE, vertexFog)}${samplerDeclarations(dimensionsOf(state), 0, 1)}
${keys.some(key=>key !== null) ? 'var<private> colourKeyed: bool = false;\n' : ''}${
    sampleFunctions(state.stages.length, state.stages.map((stage, index)=>(generated[index]
        ? { projected: stage.projected ?? 0 } : null)), keys, dimensionsOf(state), onesOf(state))}
struct VertexIn {
${inputs}
};

struct VertexOut {
    @builtin(position) @invariant position: vec4f,
${varyings.join('\n')}
};

@vertex
fn vertexMain(vertex: VertexIn${cornerInput}) -> VertexOut {
    var out: VertexOut;
${position}
${pixelCentre}${unclipped}
${pointLines.join('\n')}
${[...assignments, ...fogAmount].join('\n')}
    return out;
}

@fragment
fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
${fragmentBody(state, specularEnable, undefined, undefined,
        flat ? 'vec4f(input.specular.rgb, input.specularAlpha)' : 'input.specular',
        points?.sprite === true)}
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
 * The block the fixed-function stages read, as WGSL declares it; the layout
 * `UNIFORM_AT` in the renderer is this struct's.
 *
 * @param {number} lightCount
 */
function uniformStruct(lightCount){
    return `struct Uniforms {
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
    texTransform: array<vec4f, 32>,
    worldView: mat4x4f,
    normalMatrix: mat4x4f,
    cameraNormalMatrix: mat4x4f,
    point: vec4f,
    pointScale: vec4f,${lightCount === 0 ? '' : `
    lights: array<Light, ${lightCount}>,`}
};`;
}

/**
 * A generated three-component coordinate through the stage's texture
 * transform: (x, y, z, 1) against the four output rows the block carries,
 * which is where a translation lands for three coordinates and where the
 * component a projected sample divides by comes from.
 *
 * @param {number} index @param {string} coordinate
 */
function transformedGeneration(index, coordinate){
    const row = index * 4;
    return `vec4f(dot(uniforms.texTransform[${row}], vec4f(${coordinate}, 1.0)),`
        + ` dot(uniforms.texTransform[${row + 1}], vec4f(${coordinate}, 1.0)),`
        + ` dot(uniforms.texTransform[${row + 2}], vec4f(${coordinate}, 1.0)),`
        + ` dot(uniforms.texTransform[${row + 3}], vec4f(${coordinate}, 1.0)))`;
}

/**
 * Table fog's factor for the pixel, from the fragment position builtin: the
 * curve over its depth, which is its z when the projection is affine and its
 * w otherwise -- the reciprocal of the interpolated 1/w the builtin carries,
 * which for a pre-transformed vertex is its RHW. The choice is a uniform
 * (`fogFactors.w`), so a projection change compiles nothing.
 *
 * @param {string} position  the fragment's `@builtin(position)`
 * @returns {string}
 */
function tableFog(position){
    return `fogFactorOf(select(1.0 / ${position}.w, ${position}.z,`
        + ' uniforms.fogFactors.w != 0.0))';
}

/**
 * The fragment half of the fixed function: the stage cascade over `input`'s
 * diffuse, specular and coordinate sets, then the specular add, the fog and
 * the alpha test, leaving the result in `current`.
 *
 * @param {import('./pipeline.js').PipelineState} state
 * @param {boolean} specularEnable
 * @param {boolean[]} [generated]  Which stages sample a coordinate the
 *     vertex stage generated (`generated{n}`) rather than a carried set.
 * @param {string} [position]  The fragment's position builtin, for table fog.
 * @param {string} [specular]  What a stage reads the specular colour as.
 * @param {boolean} [sprite]  Every carried set is the point sprite's `input.sprite`.
 */
function fragmentBody(state, specularEnable, generated = state.stages.map(
    stage=>generates(stage.texCoordIndex)), position = 'input.position',
specular = 'input.specular', sprite = false)
{
    const wide = wideSets(state);
    /**
     * What a bump stage hands the stage after it: the offset its coordinate
     * moves by and the factor its texture's colour is scaled by.
     * @type {{ offset: string, luminance: string | null } | null}
     */
    let bumped = null;
    const stages = state.stages.length === 0
        ? '    var current = input.diffuse;'
        : ['    var current = input.diffuse;', ...state.stages.map((stage, index)=>{
            // The set the program bound, not the stage's own number: two stages
            // sharing one set is the ordinary way a detail or lightmap pass is
            // written, and reading set N for stage N samples a varying the
            // vertex never carried.
            const set = stage.texCoordIndex & COORD_SET_MASK;
            const flat = (stage.dimension ?? '2d') === '2d';
            const own = `input.generated${index}`;
            const coordinate = generated[index]
                ? flat ? own : stage.projected === 4 ? `(${own}.xyz / ${own}.w)` : `${own}.xyz`
                : sprite ? flat ? 'input.sprite' : 'vec3f(input.sprite, 0.0)'
                    : `input.texCoord${set}${wide.has(set) ? flat ? '.xy' : '.xyz' : ''}`;
            if (stage.colorOp === D3DTOP.BUMPENVMAP || stage.colorOp === D3DTOP.BUMPENVMAPLUMINANCE)
            {
                // The stage's texel is (du, dv, L), signed offsets and a
                // luminance; through the stage's bump matrix the offsets move
                // the next stage's coordinate, and the luminance, scaled and
                // offset, scales the next stage's texture. The stage itself
                // leaves the running colour as it was.
                const [m00, m01, m10, m11, scale, shift] = (stage.bump ?? [0, 0, 0, 0, 0, 0])
                    // A state never set reads as whatever its dword was; one
                    // that is no number has no literal.
                    .map(value=>literalOf(Number.isFinite(value) ? value : 0));
                const texel = `bump${index}`;
                bumped = {
                    offset: `vec2f(${m00} * ${texel}.r + ${m10} * ${texel}.g,`
                        + ` ${m01} * ${texel}.r + ${m11} * ${texel}.g)`,
                    luminance: stage.colorOp === D3DTOP.BUMPENVMAPLUMINANCE
                        ? `saturate(${texel}.b * ${scale} + ${shift})`
                        : null,
                };
                return `    let ${texel} = sampleStage${index}(${coordinate});`;
            }
            const from = bumped;
            bumped = null;
            // A bump stage before this one moves a flat coordinate; a cube or
            // volume one it cannot, as the hardware could not.
            // A generated flat coordinate is four wide, its last two what a
            // projected sample divides by; the offset moves its first two.
            const moved = !from || !flat ? coordinate
                : generated[index] ? `vec4f(${coordinate}.xy + ${from.offset}, ${coordinate}.zw)`
                    : `(${coordinate} + ${from.offset})`;
            const sample = `sampleStage${index}(${moved})`;
            const texture = from?.luminance
                ? `(${sample} * vec4f(vec3f(${from.luminance}), 1.0))`
                : sample;
            const color = combine(
                stage.colorOp, index, moved, stage.colorArg1, stage.colorArg2, specular,
                stage.colorArg0, texture);
            if (color === null)
            {
                return `    // stage ${index} disabled`;
            }
            const alpha = combine(
                stage.alphaOp, index, moved, stage.alphaArg1, stage.alphaArg2, specular,
                stage.alphaArg0, texture);
            // Each stage's result is held to [0, 1] before the next reads it,
            // as the fixed function's registers hold it: a sum past one or a
            // difference below zero is not carried into the stage after.
            return `    current = vec4f(saturate((${color}).rgb), `
                + `${alpha === null ? '(current).a' : `saturate((${alpha}).a)`});`;
        })].join('\n');

    // The specular colour is added after the cascade and before the fog, which
    // is where the fixed-function pipeline adds it: a highlight is light
    // reflected off the surface, not light that went through its texture.
    const highlight = specularEnable
        ? '\n    current = vec4f(current.rgb + input.specular.rgb, current.a);'
        : '';

    const fog = fogSourceOf(state) === FOG_SOURCE.NONE
        ? ''
        : '\n    current = vec4f(mix(uniforms.fogColor.rgb, current.rgb,'
            + ` clamp(${fogSourceOf(state) === FOG_SOURCE.TABLE
                ? tableFog(position) : 'input.fogAmount'}, 0.0, 1.0)), current.a);`;

    // The test discards rather than returning a transparent pixel: a discarded
    // fragment writes no depth, and one blended to zero alpha still does, which
    // is the difference between an alpha-tested fence and a fence-shaped hole
    // in everything drawn after it.
    const alphaTest = state.alphaTest
        ? `\n    if (!(${compareExpression(state.alphaFunc, 'current.a', 'uniforms.alphaRef')}))`
            + '\n    {\n        discard;\n    }'
        : '';
    // A texel of a stage's colour key is not drawn, whatever it combined to;
    // the sample that met it said so.
    const colourKey = state.stages.some(stage=>stage.colorKey !== undefined)
        ? '\n    if (colourKeyed)\n    {\n        discard;\n    }'
        : '';
    return `${stages}${highlight}${fog}${alphaTest}${colourKey}`;
}

/**
 * A fragment stage for a draw that binds a vertex shader and no pixel
 * shader: the fixed-function cascade, fog and alpha test over what the
 * shader wrote -- its colours, its coordinate sets and its fog -- which is
 * how a title of the shader-model-1 era draws nearly everything: transform
 * and skin in a program, texture and blend in the stages.
 *
 * Bound as a programmable pixel stage is: the block above at group 1's first
 * binding, the stages' textures and samplers at group 2. A varying the shader
 * does not write is not declared -- a fragment input the vertex stage does
 * not produce fails the pipeline -- and reads as the fixed function's own
 * default: opaque white diffuse, black specular, zero coordinates, and no fog.
 *
 * @param {import('./pipeline.js').PipelineState} state
 * @param {readonly number[]} written  The vertex stage's varying locations.
 * @returns {{ wgsl: string, entry: string, samplers: { index: number, type: string }[],
 *     inputs: never[], outputs: never[], reads: number[], constants: number,
 *     error: string | null }}
 */
export function fixedFragmentStage(state, written){
    const has = (/** @type {number} */ location)=>written.includes(location);
    /** @type {string[]} */
    const fields = ['    @builtin(position) position: vec4f,'];
    /** @type {string[]} */
    const carried = [];
    // The programmable convention: colours at 0 and 1, coordinate set n at
    // 2 + n, fog at 10 (`varyingLocation` in the translator). Flat shading
    // makes the two colours flat, as the shader was translated to write them.
    const interpolation = state.flatShading ? ' @interpolate(flat)' : '';
    carried.push(`    input.diffuse = ${has(0) ? 'in.v0' : 'vec4f(1.0)'};`);
    if (has(0))
    {
        fields.push(`    @location(0)${interpolation} v0: vec4f,`);
    }
    carried.push(`    input.specular = ${has(1) ? 'in.v1' : 'vec4f(0.0)'};`);
    if (has(1))
    {
        fields.push(`    @location(1)${interpolation} v1: vec4f,`);
    }
    const sets = state.stages.reduce(
        (most, stage)=>Math.max(most, (stage.texCoordIndex & COORD_SET_MASK) + 1), 0);
    const wide = wideSets(state);
    for (let set = 0; set < sets; set++)
    {
        if (has(2 + set))
        {
            fields.push(`    @location(${2 + set}) t${set}: vec4f,`);
        }
        const keep = wide.has(set);
        const absent = keep ? 'vec4f(0.0)' : 'vec2f(0.0)';
        carried.push(`    input.texCoord${set} = `
            + `${has(2 + set) ? `in.t${set}${keep ? '' : '.xy'}` : absent};`);
    }
    // Below table fog, a shader-drawn vertex is fogged by what the shader
    // wrote: its oFog when it wrote one, else its specular alpha -- neither
    // the vertex mode's curve nor its range applies -- and with neither it is
    // fogged whole (Wine's d3d8 fog_special_test).
    const fogSource = fogSourceOf(state);
    const carriedFog = fogSource === FOG_SOURCE.SPECULAR || fogSource === FOG_SOURCE.VERTEX;
    if (carriedFog)
    {
        if (has(10))
        {
            fields.push('    @location(10) fog: vec4f,');
        }
        carried.push(`    input.fogAmount = ${has(10) ? 'in.fog.x' : has(1) ? 'in.v1.a' : '0.0'};`);
    }
    const members = ['    diffuse: vec4f,', '    specular: vec4f,',
        ...Array.from({ length: sets },
            (_, set)=>`    texCoord${set}: ${wide.has(set) ? 'vec4f' : 'vec2f'},`),
        ...(carriedFog ? ['    fogAmount: f32,'] : [])];
    const wgsl = `${uniformStruct(0)}
@group(1) @binding(0) var<uniform> uniforms: Uniforms;
${functionDeclarations(null, fogSource === FOG_SOURCE.TABLE ? state.fogMode : D3DFOG.NONE)}${
    samplerDeclarations(dimensionsOf(state), 2, 0)}
${sampleFunctions(state.stages.length, [], [], dimensionsOf(state), onesOf(state))}
struct PsIn {
${fields.join('\n')}
};

struct Carried {
${members.join('\n')}
};

@fragment
fn ps_main(in: PsIn) -> @location(0) vec4f {
    var input: Carried;
${carried.join('\n')}
${fragmentBody(state, state.specularEnable === true, [], 'in.position')}
    return current;
}
`;
    return {
        wgsl, entry: 'ps_main',
        samplers: state.stages.map((stage, index)=>({ index, type: stage.dimension ?? '2d' })),
        inputs: [], outputs: [], reads: written.filter(location=>location <= 10),
        constants: 0, error: null,
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
function functionDeclarations(lighting, fogMode, perVertex = false){
    // Only for geometry that has a distance to fog by: a pre-transformed vertex
    // carries its factor already and would leave this declared and uncalled.
    const fog = fogFunctionDeclaration(fogMode, undefined, perVertex);
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
 * @param {number} count
 * @param {({ projected: number } | null)[]} [generated]
 *     Stages whose coordinate the vertex stage generated and transformed
 *     already, arriving as four components; `projected` names the one the
 *     first two are divided by, or is zero.
 * @param {(number | null)[]} [keys]
 *     Per stage, the colour key in force as 0xRRGGBB, or null: a sample
 *     whose nearest texel is that colour marks the fragment keyed. The texel
 *     itself is compared, not the filtered sample, which blends it with its
 *     neighbours, and its colour alone.
 * @param {readonly string[]} [dimensions]
 *     Per stage, '2d', 'cube' or '3d': a cube or volume stage samples three
 *     components, and is sampled by `cubeSample` or `volumeSample`.
 * @param {readonly number[]} [ones]
 *     Per stage, the channels its texture samples as one (`sampledWithOnes`).
 * @returns {string}
 */
function sampleFunctions(count, generated = [], keys = [], dimensions = [], ones = []){
    if (count === 0)
    {
        return '';
    }
    /** @type {string[]} */
    const lines = [ADDRESS_FUNCTION];
    for (let index = 0; index < count; index++)
    {
        const flags = index < 3 ? `uniforms.stage${index}` : '0u';
        const dimension = dimensions[index] ?? '2d';
        if (dimension !== '2d')
        {
            lines.push(dimension === 'cube'
                ? cubeSample(index, flags, ones[index])
                : volumeSample(index, flags, ones[index]));
            continue;
        }
        // The stage's texture transform, as Direct3D applies it to a
        // two-dimensional coordinate: (u, v, 1) through the first three rows,
        // so a translation is the third row and not the fourth. Identity rows
        // are carried for a stage without one, so the sample is one expression.
        // A generated coordinate arrives transformed by the vertex stage,
        // and a projected one is divided here, per pixel, as the rasteriser
        // does it.
        const generation = generated[index] ?? null;
        const transformed = generation
            ? `    let raw = ${generation.projected === 3 ? 'carried.xy / carried.z'
                : generation.projected === 4 ? 'carried.xy / carried.w' : 'carried.xy'};\n`
            : [
                '    let extended = vec3f(carried, 1.0);',
                `    let raw = vec2f(dot(uniforms.texTransform[${index * 4}].xyz, extended),`,
                `        dot(uniforms.texTransform[${index * 4 + 1}].xyz, extended));`,
                '',
            ].join('\n');
        const read = sampledWithOnes(
            `textureSampleLevel(texture${index}, sampler${index}, uv, level)`, ones[index]);
        lines.push(`fn sampleStage${index}(carried: ${generation ? 'vec4f' : 'vec2f'}) -> vec4f {
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
${keyTest(index, keys[index] ?? null)
}    return ${read};
}
`);
    }
    return lines.join('\n');
}

/**
 * The sampling of a cube stage: the coordinate is a direction, three
 * components, and a face's own texels are what a level is chosen by -- the
 * derivatives of the direction over its major axis, at half the face's size.
 * Address modes do not apply across a cube's faces. A point-filtered sample
 * moves the direction to the centre of the face's texel it points into: the
 * two minor components over the major one are that face's coordinates.
 *
 * @param {number} index @param {string} flags @param {number} [ones]
 */
function cubeSample(index, flags, ones){
    const read = sampledWithOnes(
        `textureSampleLevel(texture${index}, sampler${index}, towards, level)`, ones);
    return `fn sampleStage${index}(direction: vec3f) -> vec4f {
    let flags = ${flags};
    let size = f32(textureDimensions(texture${index}, 0).x);
    let axes = abs(direction);
    let major = max(max(max(axes.x, axes.y), axes.z), 1.0e-12);
    let dx = dpdx(direction) / major * size * 0.5;
    let dy = dpdy(direction) / major * size * 0.5;
    let levels = f32(textureNumLevels(texture${index}));
    let lod = clamp(0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1.0e-12)),
        f32((flags >> 8u) & 0xffu), max(levels - 1.0, 0.0));
    let mipMode = (flags >> 6u) & 3u;
    var level = f32((flags >> 8u) & 0xffu);
    if (mipMode == 1u) {
        level = round(lod);
    } else if (mipMode == 2u) {
        level = lod;
    }
    var point = (flags >> 4u) & 1u;
    if (lod > 0.0) {
        point = (flags >> 5u) & 1u;
    }
    var towards = direction;
    if (point == 1u) {
        let texels = max(floor(size / exp2(floor(level))), 1.0);
        let face = direction / major;
        let snapped = (floor((face * 0.5 + 0.5) * texels) + 0.5) / texels * 2.0 - 1.0;
        if (axes.x >= axes.y && axes.x >= axes.z) {
            towards = vec3f(face.x, snapped.yz);
        } else if (axes.y >= axes.z) {
            towards = vec3f(snapped.x, face.y, snapped.z);
        } else {
            towards = vec3f(snapped.xy, face.z);
        }
    }
    return ${read};
}
`;
}

/**
 * The sampling of a volume stage: the 2D stage's, over three coordinates,
 * with the third's address mode in bits 16-17 of the stage's flags.
 *
 * @param {number} index @param {string} flags @param {number} [ones]
 */
function volumeSample(index, flags, ones){
    const read = sampledWithOnes(
        `textureSampleLevel(texture${index}, sampler${index}, uvw, level)`, ones);
    return `fn sampleStage${index}(raw: vec3f) -> vec4f {
    let flags = ${flags};
    let size = vec3f(textureDimensions(texture${index}, 0));
    let dx = dpdx(raw * size);
    let dy = dpdy(raw * size);
    let levels = f32(textureNumLevels(texture${index}));
    let lod = clamp(0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1.0e-12)),
        f32((flags >> 8u) & 0xffu), max(levels - 1.0, 0.0));
    let mipMode = (flags >> 6u) & 3u;
    var level = f32((flags >> 8u) & 0xffu);
    if (mipMode == 1u) {
        level = round(lod);
    } else if (mipMode == 2u) {
        level = lod;
    }
    let levelSize = max(floor(size / exp2(floor(level))), vec3f(1.0));
    var uvw = vec3f(addressCoordinate(raw.x, flags & 3u, levelSize.x),
        addressCoordinate(raw.y, (flags >> 2u) & 3u, levelSize.y),
        addressCoordinate(raw.z, (flags >> 16u) & 3u, levelSize.z));
    var point = (flags >> 4u) & 1u;
    if (lod > 0.0) {
        point = (flags >> 5u) & 1u;
    }
    if (point == 1u) {
        uvw = (floor(uvw * levelSize) + 0.5) / levelSize;
    }
    return ${read};
}
`;
}

/**
 * The texture each stage samples, by dimension: '2d', 'cube' or '3d'.
 *
 * @param {import('./pipeline.js').PipelineState} state
 * @returns {string[]}
 */
function dimensionsOf(state){
    return state.stages.map(stage=>stage.dimension ?? '2d');
}

/**
 * The channels each stage's texture samples as one.
 *
 * @param {import('./pipeline.js').PipelineState} state
 * @returns {number[]}
 */
function onesOf(state){
    return state.stages.map(stage=>stage.ones ?? 0);
}

/**
 * The carried coordinate sets a cube or volume stage reads: those carry every
 * component rather than two.
 *
 * @param {import('./pipeline.js').PipelineState} state
 * @returns {Set<number>}
 */
function wideSets(state){
    return new Set(state.stages
        .filter(stage=>(stage.dimension ?? '2d') !== '2d' && !generates(stage.texCoordIndex))
        .map(stage=>stage.texCoordIndex & COORD_SET_MASK));
}

/**
 * A vertex input of `format` as four components, the missing ones zero.
 *
 * @param {string} name @param {string} format
 */
function widened(name, format){
    switch (wgslType(format))
    {
        case 'f32':
            return `vec4f(${name}, 0.0, 0.0, 0.0)`;
        case 'vec2f':
            return `vec4f(${name}, 0.0, 0.0)`;
        case 'vec3f':
            return `vec4f(${name}, 0.0)`;
        default:
            return name;
    }
}

/** The WGSL texture type of each sampled dimension. */
const TEXTURE_TYPE = Object.freeze({ '2d': 'texture_2d<f32>', cube: 'texture_cube<f32>',
    '3d': 'texture_3d<f32>' });

/**
 * The colour-key test inside a stage's sample, or nothing for a stage with
 * no key: its nearest top-level texel against the key, to within half a
 * level, the key having been expanded exactly as the texel was.
 *
 * @param {number} index @param {number | null} key  0xRRGGBB
 * @returns {string}
 */
function keyTest(index, key){
    if (key === null)
    {
        return '';
    }
    const channel = (/** @type {number} */ shift)=>literalOf(((key >>> shift) & 0xff) / 255);
    return `    let keyTexel = textureLoad(texture${index},`
        + ' vec2i(clamp(floor(uv * size), vec2f(0.0), size - 1.0)), 0);\n'
        + `    if (all(abs(keyTexel.rgb - vec3f(${channel(16)}, ${channel(8)}, ${channel(0)}))`
        + ' < vec3f(0.5 / 255.0))) {\n'
        + '        colourKeyed = true;\n'
        + '    }\n';
}

/** @param {number} value @returns {string} a WGSL float literal */
function literalOf(value){
    const text = String(value);
    return text.includes('.') || text.includes('e') ? text : `${text}.0`;
}

/**
 * Texture and sampler bindings, one pair per stage, from `first` upward in
 * `group`: the fixed-function pipeline's own group after its block, or the
 * programmable layout's sampler group from its start.
 *
 * @param {readonly string[]} dimensions  Each stage's: '2d', 'cube' or '3d'.
 * @param {number} group @param {number} first @returns {string}
 */
function samplerDeclarations(dimensions, group, first){
    /** @type {string[]} */
    const lines = [];
    for (let index = 0; index < dimensions.length; index++)
    {
        lines.push(`@group(${group}) @binding(${first + index * 2})`
            + ` var texture${index}: ${
                /** @type {Record<string, string>} */ (TEXTURE_TYPE)[dimensions[index]]};`);
        lines.push(`@group(${group}) @binding(${first + 1 + index * 2})`
            + ` var sampler${index}: sampler;`);
    }
    return lines.join('\n');
}

/**
 * A sample with the channels its texture lacks read as one, as Direct3D reads
 * them (`sampledOnes` in `d3d9/constants.js` says which): the channels kept,
 * then the constant ones, so the sample is taken once and the variant costs
 * nothing at run time over the plain read. With nothing to fill, the sample as
 * it was -- a draw of four-channel textures generates the same source.
 *
 * One definition, because the fixed-function stages and a translated shader
 * have to fill the same channels of the same texture.
 *
 * @param {string} sample  A vec4f expression.
 * @param {number} [ones]  Bit 0 red to bit 3 alpha, always the last channels;
 *     zero or absent for none.
 * @returns {string}
 */
export function sampledWithOnes(sample, ones = 0){
    if (!ones)
    {
        return sample;
    }
    const kept = 31 - Math.clz32(ones & -ones);
    if (kept === 0 || ones !== (0xf & ~((1 << kept) - 1)))
    {
        throw new Error(`a sample fills its last channels with one, not mask ${ones}`);
    }
    return `vec4f(${sample}.${'xyz'.slice(0, kept)}${', 1.0'.repeat(4 - kept)})`;
}

/**
 * The alpha test's comparison, as one WGSL expression over two names.
 *
 * One definition, because the fixed-function fragment stage and a translated
 * pixel shader's alpha test have to agree byte for byte about which way each
 * D3DCMP function points. `NEVER` and `ALWAYS` are decided before any value is
 * read, and are written as themselves rather than as a comparison no operand
 * can satisfy.
 *
 * @param {number} func  D3DCMP
 * @param {string} value  WGSL expression for the alpha being tested.
 * @param {string} reference  WGSL expression for the reference it is tested against.
 * @returns {string}
 */
export function compareExpression(func, value, reference){
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
