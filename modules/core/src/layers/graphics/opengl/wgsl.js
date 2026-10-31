/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The fixed-function GL pipeline, as a shader pair and a pipeline descriptor.
 *
 * Everything a draw's picture depends on is folded into one `DrawState`, and
 * that state is the cache key: every field read on the way to the shader or
 * the descriptor is a field the key names, written side by side so that one
 * cannot grow without the other. A key that folds less than the pipeline
 * reads hands two different draws one pipeline, and the second renders with
 * the first's blend or texture environment and reports nothing.
 *
 * The arithmetic is the specification's and the same as the processor
 * pipeline's (`pipeline.js`, `texture.js`), which is what the byte-exact tests
 * hold to: this file writes the formula in WGSL, that one in JavaScript, and
 * they agree by construction of both from the same tables. What only a device
 * can show is that the compiled shader computes what the text says.
 *
 * Two conventions cross here and are decided once:
 *
 * - **Clip space.** GL's depth runs from -w to w and WebGPU's from 0 to w, so
 *   the vertex stage remaps z; x and y and the y direction are the same in
 *   both, and so is the winding a front face is judged by, so nothing is
 *   flipped on the way through.
 * - **Texture coordinates are projective.** A unit samples at s/q, t/q, which
 *   is what a light projection through texture generation relies on; a plain
 *   coordinate carries q = 1 and the division is an identity.
 */

import { GL } from './constants.js';
import {
    CLIP_REMAP, FRAGMENT_PROGRAM_GROUP, VARYING_TEXCOORDS, emitFragment, emitVertex, needsOf,
} from './arb-wgsl.js';
import { emitStage, interfaceStruct } from './glsl-wgsl.js';

/**
 * @typedef {Object} UnitState
 *     One enabled, complete texture unit, reduced to what the formula reads.
 * @property {number} index         the unit, and the coordinate set it reads
 * @property {boolean} cube
 * @property {number} mode          GL_TEXTURE_ENV_MODE
 * @property {import('./texture.js').CombineState} combine
 * @property {boolean} hasColour    the base format carries colour
 * @property {boolean} hasAlpha     the base format carries alpha
 * @property {boolean} intensity    GL_INTENSITY, which is both at once
 * @property {boolean} rgbOnly      GL_RGB, where DECAL is a plain replace
 * @property {(number | null)[]} generation   per coordinate: the texgen mode, or null
 */

/**
 * @typedef {Object} DrawState
 *     Everything a pipeline depends on. Every field here is in the key.
 * @property {import('./gpu-layout.js').DrawAttribute[]} attributes
 * @property {number[]} strides         per slot
 * @property {'point-list' | 'line-list' | 'triangle-list'} topology
 * @property {string} targetFormat
 * @property {string} depthFormat
 * @property {UnitState[]} units
 * @property {boolean} colourSum
 * @property {{ mode: number, fromCoordinate: boolean } | null} fog
 * @property {number | null} alphaFunc  null when the alpha test is off
 * @property {boolean} flat
 * @property {import('./pipeline.js').SceneBlend | null} blend
 * @property {{ test: boolean, func: number, write: boolean }} depth
 * @property {{ func: number, fail: number, zfail: number, zpass: number,
 *              readMask: number, writeMask: number } | null} stencil
 * @property {{ func: number, fail: number, zfail: number, zpass: number,
 *              readMask: number, writeMask: number } | null} [stencilBack]
 *           GL_EXT_stencil_two_side's back-face ops. A state with no back
 *           record is one-sided: both faces get the front's ops. Optional
 *           only for this file's own pre-extension test fixtures -- every
 *           production caller (`gpu.js`) always supplies it, present exactly
 *           when `stencil` is.
 * @property {'none' | 'front' | 'back'} cull
 * @property {boolean} frontIsCcw
 * @property {number} viewportHeight  the render target's rows; fragment.position reads it
 * @property {number} colourMask     bits: red 1, green 2, blue 4, alpha 8
 * @property {{ factor: number, units: number } | null} polygonOffset
 * @property {import('./pipeline.js').SceneProgram | null} vertexProgram
 *           the enabled, loaded vertex program; null draws the fixed stage
 * @property {import('./pipeline.js').SceneProgram | null} fragmentProgram
 * @property {LightingState | null} [lighting]
 *           the fixed pipeline's lighting, when it is on and no vertex
 *           program takes its place; absent or null draws unlit
 * @property {{ count: number, distances: boolean } | null} [clip]
 *           the enabled user clip planes, in the uniform block's order, and
 *           whether the device clips by the distances a vertex stage writes
 *           (`clip-distances`) or the fragment stage discards what they cut
 * @property {{ format: string, mask: number }[]} [targets]  the colour targets,
 *           when there is more than `targetFormat` with `colourMask`: a
 *           framebuffer object's draw buffers, each with the channels it is
 *           written in (an RGB attachment's alpha is not)
 * @property {{ id: number, program: import('./glsl-link.js').LinkedProgram } | null} [glsl]
 *           the GLSL program in use: its link, by a number unique to it
 * @property {boolean} [twoSide]  GL_VERTEX_PROGRAM_TWO_SIDE, for a GLSL program
 */

/**
 * @typedef {Object} LightingState
 *     What of the lighting is the shader's text; the values are the uniforms'.
 * @property {number} lights        how many enabled lights, in order
 * @property {boolean} localViewer
 * @property {boolean} normalise    GL_NORMALIZE or GL_RESCALE_NORMAL
 * @property {boolean} separateSpecular
 * @property {number} colourMaterial  the properties the vertex colour stands
 *           for: ambient 1, diffuse 2, specular 4, emission 8
 */

/** How many texture units the uniform block and the layouts allow for. */
export const UNITS = 4;

/** How many lights the uniform block carries: GL_MAX_LIGHTS. */
export const LIGHTS = 8;

/** How many user clip planes it carries: GL_MAX_CLIP_PLANES. */
export const CLIP_PLANES = 6;

/** Floats per light in the uniform block, and where each part lies. */
const LIGHT_FLOATS = 24;
const LIGHT = Object.freeze({ ambient: 0, diffuse: 4, specular: 8, position: 12,
    spot: 16, params: 20 });

/**
 * The uniform block's layout, in floats, shared with the renderer that fills
 * it. One block per draw, so what is here is only what changes per draw.
 * The current coordinate values run to every set the varyings carry, not
 * only the conventional units: a program stage reads the sets the fixed
 * pipeline never combines.
 */
export const UNIFORM = Object.freeze({
    modelViewProjection: 0,
    modelView: 16,
    normalMatrix: 32,
    textureMatrix: 48,        // UNITS mat4x4f
    planes: 48 + UNITS * 16,  // UNITS * 4 vec4f, object or eye plane per coordinate
    color: 48 + UNITS * 32,
    secondary: 48 + UNITS * 32 + 4,
    normal: 48 + UNITS * 32 + 8,
    texCoord: 48 + UNITS * 32 + 12,      // VARYING_TEXCOORDS vec4f
    envColor: 48 + UNITS * 32 + 12 + VARYING_TEXCOORDS * 4,   // UNITS vec4f
    fogColor: 48 + UNITS * 36 + 12 + VARYING_TEXCOORDS * 4,
    fogParams: 48 + UNITS * 36 + 16 + VARYING_TEXCOORDS * 4,  // density, start, end, coordinate
    misc: 48 + UNITS * 36 + 20 + VARYING_TEXCOORDS * 4,       // alpha reference, depth direction
    lightModelAmbient: 48 + UNITS * 36 + 24 + VARYING_TEXCOORDS * 4,
    // emission, ambient, diffuse, specular, then shininess
    material: 48 + UNITS * 36 + 28 + VARYING_TEXCOORDS * 4,
    lights: 48 + UNITS * 36 + 48 + VARYING_TEXCOORDS * 4,     // LIGHTS * LIGHT_FLOATS
    // CLIP_PLANES vec4f, eye space, the enabled ones first
    clipPlanes: 48 + UNITS * 36 + 48 + VARYING_TEXCOORDS * 4 + LIGHTS * LIGHT_FLOATS,
    floats: 48 + UNITS * 36 + 48 + VARYING_TEXCOORDS * 4 + LIGHTS * LIGHT_FLOATS + CLIP_PLANES * 4,
});

export const UNIFORM_STRUCT = `struct GlLight {
    ambient: vec4f,
    diffuse: vec4f,
    specular: vec4f,
    position: vec4f,
    spot: vec4f,
    params: vec4f,
};
struct Uniforms {
    modelViewProjection: mat4x4f,
    modelView: mat4x4f,
    normalMatrix: mat4x4f,
    textureMatrix: array<mat4x4f, ${UNITS}>,
    planes: array<vec4f, ${UNITS * 4}>,
    color: vec4f,
    secondary: vec4f,
    normal: vec4f,
    texCoord: array<vec4f, ${VARYING_TEXCOORDS}>,
    envColor: array<vec4f, ${UNITS}>,
    fogColor: vec4f,
    fogParams: vec4f,
    misc: vec4f,
    lightModelAmbient: vec4f,
    material: array<vec4f, 5>,
    lights: array<GlLight, ${LIGHTS}>,
    clipPlanes: array<vec4f, ${CLIP_PLANES}>,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
`;

/** The colour-material bits, by the property they stand for. */
const COLOUR_MATERIAL_BIT = Object.freeze({ ambient: 1, diffuse: 2, specular: 4, emission: 8 });

/**
 * The lighting a draw's shader is generated for: the parts of the scene's
 * lighting that change its text. Null when the draw is unlit.
 *
 * @param {import('./pipeline.js').SceneLighting | null} lighting
 * @returns {LightingState | null}
 */
export function lightingStateOf(lighting){
    if (!lighting)
    {
        return null;
    }
    let colourMaterial = 0;
    for (const property of lighting.colourMaterial ?? [])
    {
        colourMaterial |= COLOUR_MATERIAL_BIT[property];
    }
    return {
        lights: Math.min(lighting.lights.length, LIGHTS),
        localViewer: lighting.model.localViewer,
        normalise: lighting.normalise,
        separateSpecular: lighting.model.separateSpecular,
        colourMaterial,
    };
}

/**
 * The lighting's values into a uniform block: the light model's ambient, the
 * front material and every enabled light. A spot direction goes in unit
 * length, and a light without a cone with a cosine of -2, which no angle
 * reaches, and an exponent of zero, so the shader's one formula gives it the
 * full light the specification does.
 *
 * @param {Float32Array} block
 * @param {import('./pipeline.js').SceneLighting} lighting
 */
export function writeLighting(block, lighting){
    block.set(lighting.model.ambient, UNIFORM.lightModelAmbient);
    const m = lighting.material;
    block.set(m.emission, UNIFORM.material);
    block.set(m.ambient, UNIFORM.material + 4);
    block.set(m.diffuse, UNIFORM.material + 8);
    block.set(m.specular, UNIFORM.material + 12);
    block[UNIFORM.material + 16] = m.shininess;
    const count = Math.min(lighting.lights.length, LIGHTS);
    for (let i = 0; i < count; i++)
    {
        const light = lighting.lights[i];
        const at = UNIFORM.lights + i * LIGHT_FLOATS;
        block.set(light.ambient, at + LIGHT.ambient);
        block.set(light.diffuse, at + LIGHT.diffuse);
        block.set(light.specular, at + LIGHT.specular);
        block.set(light.position, at + LIGHT.position);
        const cone = light.spotCutoff !== 180;
        const d = light.spotDirection;
        const length = Math.hypot(d[0], d[1], d[2]);
        block[at + LIGHT.spot] = length === 0 ? 0 : d[0] / length;
        block[at + LIGHT.spot + 1] = length === 0 ? 0 : d[1] / length;
        block[at + LIGHT.spot + 2] = length === 0 ? 0 : d[2] / length;
        block[at + LIGHT.spot + 3] = cone ? light.spotExponent : 0;
        block[at + LIGHT.params] = cone ? Math.cos(light.spotCutoff * Math.PI / 180) : -2;
        block[at + LIGHT.params + 1] = light.constantAttenuation;
        block[at + LIGHT.params + 2] = light.linearAttenuation;
        block[at + LIGHT.params + 3] = light.quadraticAttenuation;
    }
}

/**
 * The fixed pipeline's lighting equation as a WGSL function of the eye
 * position, the object normal and the vertex colour, returning the lit
 * primary colour: `lightVertex` (`lighting.js`) term for term, with the
 * specular term left out where the light model separates it -- as the
 * processor's path leaves it out -- and the vertex's secondary colour its
 * own. WGSL's pow is undefined at a zero base and its normalize at a zero
 * vector, where the specification has answers; those cases are spelled out.
 *
 * @param {LightingState} lighting
 * @returns {string}
 */
export function lightingFunction(lighting){
    /** @param {'ambient' | 'diffuse' | 'specular' | 'emission'} name @param {number} index */
    const property = (name, index)=>((lighting.colourMaterial & COLOUR_MATERIAL_BIT[name]) !== 0
        ? 'colour' : `uniforms.material[${index}]`);
    const normalise = lighting.normalise ? '    n = glSafeNormalize(n);\n' : '';
    const toEye = lighting.localViewer ? 'glSafeNormalize(-v)' : 'vec3f(0.0, 0.0, 1.0)';
    const sum = lighting.separateSpecular ? 'lit' : 'lit + highlight';
    return `fn glSafeNormalize(v: vec3f) -> vec3f {
    let l = length(v);
    return select(vec3f(0.0), v / l, l > 0.0);
}
fn glPow(base: f32, exponent: f32) -> f32 {
    if (exponent == 0.0) { return 1.0; }
    if (base <= 0.0) { return 0.0; }
    return pow(base, exponent);
}
fn glLit(eye: vec4f, objectNormal: vec3f, colour: vec4f) -> vec4f {
    var n = (uniforms.normalMatrix * vec4f(objectNormal, 0.0)).xyz;
${normalise}    let emission = ${property('emission', 0)};
    let ambient = ${property('ambient', 1)};
    let diffuse = ${property('diffuse', 2)};
    let specular = ${property('specular', 3)};
    let v = eye.xyz / select(eye.w, 1.0, eye.w == 0.0);
    var lit = emission.rgb + uniforms.lightModelAmbient.rgb * ambient.rgb;
    var highlight = vec3f(0.0);
    for (var i = 0u; i < ${lighting.lights}u; i++) {
        let light = uniforms.lights[i];
        var toLight = glSafeNormalize(light.position.xyz);
        var attenuation = 1.0;
        if (light.position.w != 0.0) {
            let delta = light.position.xyz / light.position.w - v;
            let distance = length(delta);
            toLight = glSafeNormalize(delta);
            attenuation = 1.0 / (light.params.y + light.params.z * distance
                + light.params.w * distance * distance);
        }
        var spot = 1.0;
        if (light.params.x > -1.5) {
            let cosine = -dot(toLight, light.spot.xyz);
            spot = select(glPow(max(cosine, 0.0), light.spot.w), 0.0, cosine < light.params.x);
        }
        let diffuseDot = max(0.0, dot(n, toLight));
        let scale = attenuation * spot;
        lit += scale * (light.ambient.rgb * ambient.rgb
            + diffuseDot * light.diffuse.rgb * diffuse.rgb);
        if (diffuseDot > 0.0) {
            let toEye = ${toEye};
            let halfway = glSafeNormalize(toLight + toEye);
            let specularDot = max(0.0, dot(n, halfway));
            highlight += scale * glPow(specularDot, uniforms.material[4].x)
                * light.specular.rgb * specular.rgb;
        }
    }
    return vec4f(clamp(${sum}, vec3f(0.0), vec3f(1.0)), clamp(diffuse.a, 0.0, 1.0));
}`;
}

/** GL comparison → WebGPU compare function. */
const COMPARE = Object.freeze({
    [GL.NEVER]: 'never',
    [GL.LESS]: 'less',
    [GL.EQUAL]: 'equal',
    [GL.LEQUAL]: 'less-equal',
    [GL.GREATER]: 'greater',
    [GL.NOTEQUAL]: 'not-equal',
    [GL.GEQUAL]: 'greater-equal',
    [GL.ALWAYS]: 'always',
});

/** GL blend factor → WebGPU blend factor. */
const BLEND_FACTOR = Object.freeze({
    [GL.ZERO]: 'zero',
    [GL.ONE]: 'one',
    [GL.SRC_COLOR]: 'src',
    [GL.ONE_MINUS_SRC_COLOR]: 'one-minus-src',
    [GL.SRC_ALPHA]: 'src-alpha',
    [GL.ONE_MINUS_SRC_ALPHA]: 'one-minus-src-alpha',
    [GL.DST_ALPHA]: 'dst-alpha',
    [GL.ONE_MINUS_DST_ALPHA]: 'one-minus-dst-alpha',
    [GL.DST_COLOR]: 'dst',
    [GL.ONE_MINUS_DST_COLOR]: 'one-minus-dst',
    [GL.SRC_ALPHA_SATURATE]: 'src-alpha-saturated',
    [GL.CONSTANT_COLOR]: 'constant',
    [GL.ONE_MINUS_CONSTANT_COLOR]: 'one-minus-constant',
    // WebGPU has one constant, which a factor takes whole: a constant-alpha
    // factor is the constant's grey, which `gpu.js` sets it to when the
    // blend uses no constant colour (`blendConstantOf`).
    [GL.CONSTANT_ALPHA]: 'constant',
    [GL.ONE_MINUS_CONSTANT_ALPHA]: 'one-minus-constant',
});

/** GL blend equation → WebGPU blend operation. */
const BLEND_OPERATION = Object.freeze({
    [GL.FUNC_ADD]: 'add',
    [GL.FUNC_SUBTRACT]: 'subtract',
    [GL.FUNC_REVERSE_SUBTRACT]: 'reverse-subtract',
    [GL.MIN]: 'min',
    [GL.MAX]: 'max',
});

/** GL stencil operation → WebGPU stencil operation. */
const STENCIL_OP = Object.freeze({
    [GL.KEEP]: 'keep',
    [GL.ZERO]: 'zero',
    [GL.REPLACE]: 'replace',
    [GL.INCR]: 'increment-clamp',
    [GL.DECR]: 'decrement-clamp',
    [GL.INVERT]: 'invert',
    [GL.INCR_WRAP]: 'increment-wrap',
    [GL.DECR_WRAP]: 'decrement-wrap',
});

/** @param {Record<number, string>} table @param {number} value @param {string} what */
function lookUp(table, value, what){
    const found = table[value];
    if (found === undefined)
    {
        throw new Error(`Unsupported ${what}: 0x${value.toString(16)}`);
    }
    return found;
}

/**
 * The key a pipeline is cached under. A string, compared by value on every
 * draw and readable in a diagnostic.
 *
 * Built with plain loops and `+=` rather than `.map().join()`: this runs on
 * every draw regardless of whether the pipeline it names is already cached
 * (the key is what the cache is looked up by), so the array `.map()` would
 * have allocated for `attributes` and `units` -- thrown away the instant
 * `.join()` read it -- is real per-draw garbage a state that repeats a
 * hundred times a frame pays for nothing.
 *
 * @param {DrawState} state
 * @returns {string}
 */
export function drawKey(state){
    let attributes = '';
    for (let i = 0; i < state.attributes.length; i++)
    {
        if (i > 0)
        {
            attributes += ',';
        }
        const a = state.attributes[i];
        attributes += `${a.name}:${a.slot}:${a.offset}:${a.format}`;
    }
    let units = '';
    for (let i = 0; i < state.units.length; i++)
    {
        if (i > 0)
        {
            units += ';';
        }
        const unit = state.units[i];
        const c = unit.combine;
        const combined = unit.mode === GL.COMBINE
            ? `${c.rgb},${c.alpha},${c.sourceRgb.join('.')},${c.sourceAlpha.join('.')},`
                + `${c.operandRgb.join('.')},${c.operandAlpha.join('.')},${c.rgbScale},`
                + `${c.alphaScale}`
            : '';
        let generation = '';
        for (let k = 0; k < unit.generation.length; k++)
        {
            if (k > 0)
            {
                generation += '.';
            }
            generation += unit.generation[k] === null ? '-' : String(unit.generation[k]);
        }
        units += `${unit.index}${unit.cube ? 'c' : ''}:${unit.mode}:${combined}:`
            + `${unit.hasColour ? 1 : 0}${unit.hasAlpha ? 1 : 0}${unit.intensity ? 1 : 0}`
            + `${unit.rgbOnly ? 1 : 0}:${generation}`;
    }
    /** @param {DrawState['stencil']} face */
    const stencilFace = face=>(face
        ? `${face.func},${face.fail},${face.zfail},${face.zpass},${face.readMask},`
            + `${face.writeMask}`
        : '-');
    /** @param {DrawState['stencil']} face the back's own ops, without the masks WebGPU
     *  never applies to it (they are the shared, front-only ones `stencil` already keys) */
    const stencilBackFace = face=>(face
        ? `${face.func},${face.fail},${face.zfail},${face.zpass}`
        : '-');
    const stencil = stencilFace(state.stencil);
    const stencilBack = stencilBackFace(state.stencilBack ?? state.stencil);
    return [
        attributes,
        state.strides.join(','),
        state.topology,
        state.targetFormat,
        state.depthFormat,
        `[${units}]`,
        state.colourSum ? 1 : 0,
        state.fog ? `${state.fog.mode}${state.fog.fromCoordinate ? 'c' : ''}` : '-',
        state.alphaFunc === null ? '-' : state.alphaFunc,
        state.flat ? 1 : 0,
        state.blend ? blendKey(state.blend) : '-',
        `${state.depth.test ? 1 : 0}${state.depth.write ? 1 : 0},${state.depth.func}`,
        stencil,
        stencilBack,
        state.cull,
        state.frontIsCcw ? 'ccw' : 'cw',
        state.colourMask,
        state.polygonOffset ? `${state.polygonOffset.factor},${state.polygonOffset.units}` : '-',
        state.vertexProgram
            ? `vp${state.vertexProgram.name}.${state.vertexProgram.version}`
            : '-',
        lightingKey(state.lighting),
        state.clip ? `C${state.clip.count}${state.clip.distances ? 'd' : ''}` : '-',
        state.fragmentProgram
            ? `fp${state.fragmentProgram.name}.${state.fragmentProgram.version}.`
                + `${state.viewportHeight ?? 0}`
            : '-',
        targetsKey(state.targets),
        state.glsl ? `g${state.glsl.id}${state.twoSide ? 't' : ''}` : '-',
    ].join('|');
}

/**
 * @param {NonNullable<DrawState['blend']>} blend
 * @returns {string}
 */
const blendKey = blend=>`${blend.src},${blend.dst}`
    + `${blend.srcAlpha === undefined ? '' : `,${blend.srcAlpha},${blend.dstAlpha},`
        + `${blend.equation},${blend.equationAlpha}`}`;

/** @param {DrawState['targets']} targets */
const targetsKey = targets=>{
    if (!targets)
    {
        return '-';
    }
    let key = '';
    for (const target of targets)
    {
        key += `${target.format}/${target.mask};`;
    }
    return key;
};

/** @param {LightingState | null | undefined} lighting */
const lightingKey = lighting=>(lighting
    ? `L${lighting.lights}${lighting.localViewer ? 'v' : ''}${lighting.normalise ? 'n' : ''}`
        + `${lighting.separateSpecular ? 's' : ''}${lighting.colourMaterial}`
    : '-');

/** @param {ArrayLike<any>} a @param {ArrayLike<any>} b */
const sameItems = (a, b)=>{
    if (a.length !== b.length)
    {
        return false;
    }
    for (let i = 0; i < a.length; i++)
    {
        if (a[i] !== b[i])
        {
            return false;
        }
    }
    return true;
};

/**
 * @param {DrawState['stencil']} a @param {DrawState['stencil']} b
 * @param {boolean} masks
 */
const sameStencil = (a, b, masks)=>a === b || (!!a && !!b && a.func === b.func
    && a.fail === b.fail && a.zfail === b.zfail && a.zpass === b.zpass
    && (!masks || (a.readMask === b.readMask && a.writeMask === b.writeMask)));

/**
 * Whether two states have the same `drawKey`, without building either: every
 * value the key prints, compared as it is printed or more strictly, so a true
 * answer always means equal keys and a false one at worst builds a key that
 * turns out the same. Most draws keep the state of the draw before them, and
 * the key is a string of a hundred-odd characters made on every one. Every
 * object a state holds is made for that state and not changed after, but a
 * unit's combiner, which is why a unit in COMBINE mode is never the same.
 *
 * @param {DrawState} a @param {DrawState} b
 * @returns {boolean}
 */
export function sameKeyInputs(a, b){
    if (a.topology !== b.topology || a.targetFormat !== b.targetFormat
        || a.depthFormat !== b.depthFormat || !a.colourSum !== !b.colourSum
        || a.alphaFunc !== b.alphaFunc || !a.flat !== !b.flat || a.cull !== b.cull
        || !a.frontIsCcw !== !b.frontIsCcw || a.colourMask !== b.colourMask
        || !sameItems(a.strides, b.strides)
        || a.attributes.length !== b.attributes.length || a.units.length !== b.units.length)
    {
        return false;
    }
    for (let i = 0; i < a.attributes.length; i++)
    {
        const x = a.attributes[i];
        const y = b.attributes[i];
        if (x !== y && (x.name !== y.name || x.slot !== y.slot || x.offset !== y.offset
            || x.format !== y.format))
        {
            return false;
        }
    }
    for (let i = 0; i < a.units.length; i++)
    {
        const x = a.units[i];
        const y = b.units[i];
        if (x.index !== y.index || !x.cube !== !y.cube || x.mode !== y.mode
            || !x.hasColour !== !y.hasColour || !x.hasAlpha !== !y.hasAlpha
            || !x.intensity !== !y.intensity || !x.rgbOnly !== !y.rgbOnly
            || !sameItems(x.generation, y.generation))
        {
            return false;
        }
        // A unit's combiner is the context's own record, changed in place by
        // glTexEnv: the state a previous draw kept may name the very object
        // this one does, so there is nothing to compare it with.
        if (x.mode === GL.COMBINE)
        {
            return false;
        }
    }
    const fa = a.fog;
    const fb = b.fog;
    if (fa !== fb
        && (!fa || !fb || fa.mode !== fb.mode || !fa.fromCoordinate !== !fb.fromCoordinate))
    {
        return false;
    }
    const ba = a.blend;
    const bb = b.blend;
    if (ba !== bb && (!ba || !bb || ba.src !== bb.src || ba.dst !== bb.dst
        || ba.srcAlpha !== bb.srcAlpha || ba.dstAlpha !== bb.dstAlpha
        || ba.equation !== bb.equation || ba.equationAlpha !== bb.equationAlpha))
    {
        return false;
    }
    if (targetsKey(a.targets) !== targetsKey(b.targets) || (a.glsl?.id ?? 0) !== (b.glsl?.id ?? 0)
        || !a.twoSide !== !b.twoSide)
    {
        return false;
    }
    if (!a.depth.test !== !b.depth.test || !a.depth.write !== !b.depth.write
        || a.depth.func !== b.depth.func)
    {
        return false;
    }
    if (!sameStencil(a.stencil, b.stencil, true)
        || !sameStencil(a.stencilBack ?? a.stencil, b.stencilBack ?? b.stencil, false))
    {
        return false;
    }
    const pa = a.polygonOffset;
    const pb = b.polygonOffset;
    if (pa !== pb && (!pa || !pb || pa.factor !== pb.factor || pa.units !== pb.units))
    {
        return false;
    }
    const ca = a.clip ?? null;
    const cb = b.clip ?? null;
    if (ca !== cb && (!ca || !cb || ca.count !== cb.count || ca.distances !== cb.distances))
    {
        return false;
    }
    const la = a.lighting ?? null;
    const lb = b.lighting ?? null;
    if (la !== lb && (!la || !lb || la.lights !== lb.lights || la.localViewer !== lb.localViewer
        || la.normalise !== lb.normalise || la.separateSpecular !== lb.separateSpecular
        || la.colourMaterial !== lb.colourMaterial))
    {
        return false;
    }
    const va = a.vertexProgram;
    const vb = b.vertexProgram;
    if (va !== vb && (!va || !vb || va.name !== vb.name || va.version !== vb.version))
    {
        return false;
    }
    const ga = a.fragmentProgram;
    const gb = b.fragmentProgram;
    return ga === gb ? !ga || (a.viewportHeight ?? 0) === (b.viewportHeight ?? 0)
        : !!ga && !!gb && ga.name === gb.name && ga.version === gb.version
            && (a.viewportHeight ?? 0) === (b.viewportHeight ?? 0);
}

/**
 * The WGSL type an attribute arrives as.
 *
 * @param {import('./gpu-layout.js').DrawAttribute} attribute
 */
export function attributeType(attribute){
    const scalar = attribute.scalar;
    return attribute.components === 1 ? scalar : `vec${attribute.components}<${scalar}>`;
}

/**
 * An attribute widened to a vec4f with the given fill for the components it
 * lacks, the integer kinds converted.
 *
 * @param {import('./gpu-layout.js').DrawAttribute} attribute
 * @param {number[]} fill   four defaults; the last components that are missing
 */
function widen(attribute, fill){
    const source = attribute.scalar === 'f32'
        ? `vertex.${attribute.name}`
        : `${attribute.components === 1 ? 'f32' : `vec${attribute.components}f`}`
            + `(vertex.${attribute.name})`;
    if (attribute.components === 4)
    {
        return source;
    }
    const missing = fill.slice(attribute.components).map(value=>value.toFixed(1));
    return `vec4f(${source}, ${missing.join(', ')})`;
}

/**
 * The texture coordinates of one unit, generated where the unit says so and
 * put through its matrix. `objectPosition`, `eyePosition` and `eyeNormal`
 * are in scope.
 *
 * @param {UnitState} unit
 * @param {string} given   a vec4f expression: the attribute or the current value
 */
function textureCoordinates(unit, given){
    const lines = [`    var tc${unit.index} = ${given};`];
    const swizzle = ['x', 'y', 'z', 'w'];
    let reflection = false;
    unit.generation.forEach((mode, k)=>{
        if (mode === null)
        {
            return;
        }
        const plane = `uniforms.planes[${unit.index * 4 + k}]`;
        if (mode === GL.OBJECT_LINEAR)
        {
            lines.push(`    tc${unit.index}.${swizzle[k]} = dot(objectPosition, ${plane});`);
        }
        else if (mode === GL.EYE_LINEAR)
        {
            lines.push(`    tc${unit.index}.${swizzle[k]} = dot(eyePosition, ${plane});`);
        }
        else if (mode === GL.SPHERE_MAP && k < 2)
        {
            if (!reflection)
            {
                lines.push(`    let r${unit.index} = reflect(eyeDirection, eyeNormal);`);
                reflection = true;
            }
            lines.push(`    tc${unit.index}.${swizzle[k]} = sphereMap(r${unit.index})`
                + `.${swizzle[k]};`);
        }
        else if (mode === GL.REFLECTION_MAP && k < 3)
        {
            if (!reflection)
            {
                lines.push(`    let r${unit.index} = reflect(eyeDirection, eyeNormal);`);
                reflection = true;
            }
            lines.push(`    tc${unit.index}.${swizzle[k]} = r${unit.index}.${swizzle[k]};`);
        }
        else if (mode === GL.NORMAL_MAP && k < 3)
        {
            lines.push(`    tc${unit.index}.${swizzle[k]} = eyeNormal.${swizzle[k]};`);
        }
    });
    lines.push(`    out.tc${unit.index} = uniforms.textureMatrix[${unit.index}]`
        + ` * tc${unit.index};`);
    return lines.join('\n');
}

/**
 * The fog factor of a fog coordinate, as the specification's three curves.
 *
 * @param {{ mode: number }} fog
 */
export function fogFactorOf(fog){
    switch (fog.mode)
    {
        case GL.LINEAR:
            return '(uniforms.fogParams.z - c)'
                + ' / max(uniforms.fogParams.z - uniforms.fogParams.y, 1e-6)';
        case GL.EXP2:
            return 'exp(-(uniforms.fogParams.x * c) * (uniforms.fogParams.x * c))';
        default:
            return 'exp(-uniforms.fogParams.x * c)';
    }
}

/**
 * @param {number} func
 * @param {string} value
 * @param {string} reference
 */
export function compareExpression(func, value, reference){
    switch (func)
    {
        case GL.NEVER:
            return 'false';
        case GL.LESS:
            return `${value} < ${reference}`;
        case GL.EQUAL:
            return `${value} == ${reference}`;
        case GL.LEQUAL:
            return `${value} <= ${reference}`;
        case GL.GREATER:
            return `${value} > ${reference}`;
        case GL.NOTEQUAL:
            return `${value} != ${reference}`;
        case GL.GEQUAL:
            return `${value} >= ${reference}`;
        default:
            return 'true';
    }
}

/**
 * @param {number} source
 * @param {UnitState} unit
 * @returns {string} a vec4f expression
 */
function combineSource(source, unit){
    switch (source)
    {
        case GL.TEXTURE:
            return `t${unit.index}`;
        case GL.CONSTANT:
            return `uniforms.envColor[${unit.index}]`;
        case GL.PRIMARY_COLOR:
            return 'primary';
        default:
            return 'current';
    }
}

/**
 * @param {number} operand
 * @param {string} colour  a vec4f expression
 * @returns {string} a vec3f expression
 */
function combineOperandRgb(operand, colour){
    switch (operand)
    {
        case GL.ONE_MINUS_SRC_COLOR:
            return `(vec3f(1.0) - (${colour}).rgb)`;
        case GL.SRC_ALPHA:
            return `vec3f((${colour}).a)`;
        case GL.ONE_MINUS_SRC_ALPHA:
            return `vec3f(1.0 - (${colour}).a)`;
        default:
            return `(${colour}).rgb`;
    }
}

/**
 * @param {number} operand
 * @param {string} colour
 * @returns {string} an f32 expression
 */
function combineOperandAlpha(operand, colour){
    return operand === GL.ONE_MINUS_SRC_ALPHA || operand === GL.ONE_MINUS_SRC_COLOR
        ? `(1.0 - (${colour}).a)`
        : `(${colour}).a`;
}

/**
 * @param {number} function_
 * @param {string} a0 @param {string} a1 @param {string} a2   vec3f or f32 expressions
 * @param {boolean} rgb
 */
function combineFunction(function_, a0, a1, a2, rgb){
    switch (function_)
    {
        case GL.MODULATE:
            return `${a0} * ${a1}`;
        case GL.ADD:
            return `${a0} + ${a1}`;
        case GL.ADD_SIGNED:
            return `${a0} + ${a1} - 0.5`;
        case GL.INTERPOLATE:
            return `${a0} * ${a2} + ${a1} * (1.0 - ${a2})`;
        case GL.SUBTRACT:
            return `${a0} - ${a1}`;
        case GL.DOT3_RGB:
        case GL.DOT3_RGBA:
            return rgb
                ? `vec3f(4.0 * dot(${a0} - vec3f(0.5), ${a1} - vec3f(0.5)))`
                : a0;
        default:
            return a0;
    }
}

/**
 * GL_COMBINE for one unit: the new `current`.
 *
 * @param {UnitState} unit
 */
function combine(unit){
    const c = unit.combine;
    const rgbArgs = [0, 1, 2].map(i=>combineOperandRgb(c.operandRgb[i],
        combineSource(c.sourceRgb[i], unit)));
    const alphaArgs = [0, 1, 2].map(i=>combineOperandAlpha(c.operandAlpha[i],
        combineSource(c.sourceAlpha[i], unit)));
    const rgb = `clamp((${combineFunction(c.rgb, rgbArgs[0], rgbArgs[1], rgbArgs[2], true)})`
        + ` * ${c.rgbScale.toFixed(1)}, vec3f(0.0), vec3f(1.0))`;
    const alpha = c.rgb === GL.DOT3_RGBA
        ? 'rgb.x'
        : `clamp((${combineFunction(c.alpha, alphaArgs[0], alphaArgs[1], alphaArgs[2], false)})`
            + ` * ${c.alphaScale.toFixed(1)}, 0.0, 1.0)`;
    return `    {\n        let rgb = ${rgb};\n        current = vec4f(rgb, ${alpha});\n    }`;
}

/**
 * The texture environment of one unit applied to `current`, per the
 * specification's table for the unit's base format.
 *
 * @param {UnitState} unit
 */
function environment(unit){
    const t = `t${unit.index}`;
    const colour = (/** @type {string} */ rgb)=>(unit.hasColour ? rgb : 'current.rgb');
    switch (unit.mode)
    {
        case GL.REPLACE:
            return `    current = vec4f(${colour(`${t}.rgb`)}, `
                + `${unit.hasAlpha ? `${t}.a` : 'current.a'});`;
        case GL.MODULATE:
            return `    current = vec4f(${colour(`current.rgb * ${t}.rgb`)}, `
                + `${unit.hasAlpha ? `current.a * ${t}.a` : 'current.a'});`;
        case GL.DECAL:
            return unit.rgbOnly
                ? `    current = vec4f(${t}.rgb, current.a);`
                : `    current = vec4f(mix(current.rgb, ${t}.rgb, ${t}.a), current.a);`;
        case GL.BLEND:
        {
            const cc = `uniforms.envColor[${unit.index}]`;
            const alpha = unit.intensity
                ? `mix(current.a, ${cc}.a, ${t}.a)`
                : unit.hasAlpha ? `current.a * ${t}.a` : 'current.a';
            return `    current = vec4f(${colour(`mix(current.rgb, ${cc}.rgb, ${t}.rgb)`)}, `
                + `${alpha});`;
        }
        case GL.ADD:
        {
            const alpha = unit.intensity
                ? `min(current.a + ${t}.a, 1.0)`
                : unit.hasAlpha ? `current.a * ${t}.a` : 'current.a';
            return `    current = vec4f(${colour(`min(current.rgb + ${t}.rgb, vec3f(1.0))`)}, `
                + `${alpha});`;
        }
        case GL.COMBINE:
            return combine(unit);
        default:
            return `    // unit ${unit.index}: environment mode 0x${unit.mode.toString(16)}`
                + ' left the colour alone';
    }
}

/**
 * The varying struct both stages share: the vertex side declares it, the
 * fragment side reads it, and a program stage and a fixed stage agree on it
 * because both are generated against the same set.
 *
 * @param {import('./arb-wgsl.js').StageVaryings} varyings
 * @param {boolean} flat
 * @param {{ count: number, distances: boolean } | null} [clip]  the user clip planes'
 *     distances: a builtin the device clips by, or two vectors the fragment discards by
 */
function vertexOutStruct(varyings, flat, clip = null){
    const interpolation = flat ? '@interpolate(flat) ' : '';
    const next = 3 + varyings.texcoords.length + (varyings.fogCoord ? 1 : 0);
    // The device's clip distances are a vertex output only, never a fragment
    // input: a stage that writes them returns a struct of its own with them,
    // and the fragment stage reads the rest by location as ever.
    const clipFields = !clip || clip.distances ? []
        : [`    @location(${next}) clipLow: vec4f,`, `    @location(${next + 1}) clipHigh: vec4f,`];
    // Invariant, so that two modules computing one position from the same
    // data agree to the bit: a depth-equal pass drawn through a different
    // module than the pass before it would otherwise be free to fight it.
    const fields = [
        '    @builtin(position) @invariant position: vec4f,',
        `    @location(0) ${interpolation}color: vec4f,`,
        `    @location(1) ${interpolation}secondary: vec4f,`,
        '    @location(2) fog: f32,',
        ...varyings.texcoords.map((set, i)=>`    @location(${3 + i}) tc${set}: vec4f,`),
        ...(varyings.fogCoord
            ? [`    @location(${3 + varyings.texcoords.length}) fogCoord: f32,`]
            : []),
        ...clipFields,
    ];
    const clipped = clip?.distances
        ? `
struct VertexOutClipped {
${fields.join('\n')}
    @builtin(clip_distances) clipDistances: array<f32, ${clip.count}>,
};`
        : '';
    return `struct VertexOut {
${fields.join('\n')}
};${clipped}`;
}

/** @param {DrawState} state */
function fixedVertexIn(state){
    const inputs = state.attributes
        .map((attribute, location)=>
            `    @location(${location}) ${attribute.name}: ${attributeType(attribute)},`)
        .join('\n');
    return `struct VertexIn {
${inputs}
};`;
}

/**
 * The fixed-function vertex stage, generating the varyings it was told to:
 * the enabled units' sets on the fixed path, and every set plus the raw fog
 * coordinate when a fragment program is the one reading them.
 *
 * @param {DrawState} state
 * @param {import('./arb-wgsl.js').StageVaryings} varyings
 */
function fixedVertexMain(state, varyings){
    const has = (/** @type {string} */ name)=>state.attributes.find(a=>a.name === name);
    const position = has('position');
    const colour = has('color');
    const secondary = has('secondary');
    const normal = has('normal');
    const fogCoordAttribute = has('fogCoord');
    const needsNormal = state.units.some(unit=>unit.generation.some(mode=>
        mode === GL.SPHERE_MAP || mode === GL.REFLECTION_MAP || mode === GL.NORMAL_MAP));

    const vertexBody = [
        `    let objectPosition = ${position
            ? widen(position, [0, 0, 0, 1])
            : 'vec4f(0.0, 0.0, 0.0, 1.0)'};`,
        '    let eyePosition = uniforms.modelView * objectPosition;',
        '    let clip = uniforms.modelViewProjection * objectPosition;',
        // GL's near plane is z = -w; WebGPU's is z = 0. The direction is -1
        // for a depth range run backwards, which the viewport cannot express.
        `    out.position = ${CLIP_REMAP};`,
        `    out.color = ${colour ? widen(colour, [0, 0, 0, 1]) : 'uniforms.color'};`,
        `    out.secondary = ${secondary ? widen(secondary, [0, 0, 0, 1]) : 'uniforms.secondary'};`,
    ];
    const clip = state.clip;
    if (clip)
    {
        const distance = (/** @type {number} */ plane)=>(plane < clip.count
            ? `dot(eyePosition, uniforms.clipPlanes[${plane}])` : '1.0');
        if (clip.distances)
        {
            for (let plane = 0; plane < clip.count; plane++)
            {
                vertexBody.push(`    out.clipDistances[${plane}] = ${distance(plane)};`);
            }
        }
        else
        {
            vertexBody.push(`    out.clipLow = vec4f(${[0, 1, 2, 3].map(distance).join(', ')});`,
                `    out.clipHigh = vec4f(${[4, 5, 6, 7].map(distance).join(', ')});`);
        }
    }
    if (state.lighting)
    {
        vertexBody.push(`    out.color = glLit(eyePosition, ${normal
            ? widen(normal, [0, 0, 1, 0])
            : 'uniforms.normal'}.xyz, out.color);`);
    }
    if (needsNormal)
    {
        vertexBody.push(
            `    let objectNormal = ${normal
                ? widen(normal, [0, 0, 1, 0])
                : 'uniforms.normal'};`,
            '    let eyeNormal = normalize('
                + '(uniforms.normalMatrix * vec4f(objectNormal.xyz, 0.0)).xyz);',
            '    let eyeDirection = normalize('
                + 'eyePosition.xyz / select(eyePosition.w, 1.0, eyePosition.w == 0.0));');
    }
    if (state.fog || varyings.fogCoord)
    {
        const fromCoordinate = state.fog ? state.fog.fromCoordinate : false;
        const c = fromCoordinate
            ? (fogCoordAttribute ? 'vertex.fogCoord' : 'uniforms.fogParams.w')
            : 'abs(eyePosition.z / select(eyePosition.w, 1.0, eyePosition.w == 0.0))';
        vertexBody.push(`    let c = ${c};`);
        vertexBody.push(state.fog
            ? `    out.fog = clamp(${fogFactorOf(state.fog)}, 0.0, 1.0);`
            : '    out.fog = 1.0;');
        if (varyings.fogCoord)
        {
            vertexBody.push('    out.fogCoord = c;');
        }
    }
    else
    {
        vertexBody.push('    out.fog = 1.0;');
    }
    for (const set of varyings.texcoords)
    {
        const attribute = has(`texCoord${set}`);
        const given = attribute
            ? widen(attribute, [0, 0, 0, 1])
            : `uniforms.texCoord[${set}]`;
        const unit = state.units.find(candidate=>candidate.index === set);
        if (unit)
        {
            vertexBody.push(textureCoordinates(unit, given));
        }
        else
        {
            // A set the fixed pipeline is not running carries its coordinate
            // through as it is, for the program stage that reads it.
            vertexBody.push(`    out.tc${set} = ${given};`);
        }
    }
    const output = state.clip?.distances ? 'VertexOutClipped' : 'VertexOut';
    return `@vertex
fn vertexMain(vertex: VertexIn) -> ${output} {
    var out: ${output};
${vertexBody.join('\n')}
    return out;
}`;
}

/** The fixed-function fragment stage: its texture bindings and its entry. */
const SPHERE_MAP_FN = `fn sphereMap(r: vec3f) -> vec2f {
    let m = 2.0 * sqrt(r.x * r.x + r.y * r.y + (r.z + 1.0) * (r.z + 1.0));
    return select(r.xy / m + vec2f(0.5), vec2f(0.5), m == 0.0);
}`;

/**
 * @param {DrawState} state
 * @returns {{ bindings: string, main: string }}
 */
function fixedFragment(state){
    const bindings = state.units.map((unit, i)=>
        `@group(0) @binding(${1 + i * 2}) var t${unit.index}Texture: `
        + `${unit.cube ? 'texture_cube<f32>' : 'texture_2d<f32>'};\n`
        + `@group(0) @binding(${2 + i * 2}) var t${unit.index}Sampler: sampler;`).join('\n');

    const fragmentBody = [
        ...(state.clip && !state.clip.distances
            ? ['    if (any(input.clipLow < vec4f(0.0)) || any(input.clipHigh < vec4f(0.0)))',
                '    {', '        discard;', '    }']
            : []),
        '    let primary = clamp(input.color, vec4f(0.0), vec4f(1.0));',
        '    var current = primary;',
    ];
    for (const unit of state.units)
    {
        const tc = `input.tc${unit.index}`;
        fragmentBody.push(unit.cube
            ? `    let t${unit.index} = textureSample(t${unit.index}Texture,`
                + ` t${unit.index}Sampler, ${tc}.xyz);`
            : `    let t${unit.index} = textureSample(t${unit.index}Texture,`
                + ` t${unit.index}Sampler, ${tc}.xy / ${tc}.w);`);
        fragmentBody.push(environment(unit));
    }
    if (state.colourSum)
    {
        fragmentBody.push('    current = vec4f(current.rgb'
            + ' + clamp(input.secondary, vec4f(0.0), vec4f(1.0)).rgb, current.a);');
    }
    if (state.fog)
    {
        fragmentBody.push(
            '    current = vec4f(mix(uniforms.fogColor.rgb, current.rgb, input.fog), current.a);');
    }
    if (state.alphaFunc !== null)
    {
        // Discarded rather than written transparent: a discarded fragment
        // writes no depth and no stencil, and one written at zero alpha does.
        fragmentBody.push(
            `    if (!(${compareExpression(state.alphaFunc, 'current.a', 'uniforms.misc.x')}))`,
            '    {', '        discard;', '    }');
    }
    fragmentBody.push('    return current;');
    const main = `@fragment
fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
${fragmentBody.join('\n')}
}`;
    return { bindings, main };
}

/**
 * The shader pair for a draw state, as one module with both entry points,
 * and -- when a program stage runs -- what its uniform block has to carry.
 *
 * @param {DrawState} state
 * @returns {{ code: string, label: string,
 *             programs: ProgramStages | null, glsl?: GlslStages }}
 */
export function generateDraw(state){
    const made = state.glsl ? generateGlslDraw(state)
        : state.vertexProgram || state.fragmentProgram ? generateProgramDraw(state)
            : generateFixedDraw(state);
    const targets = state.targets?.length ?? 1;
    return targets > 1 && !state.glsl && made.code !== '' ? { ...made,
        code: broadcast(made.code, targets) } : made;
}

/**
 * A fragment stage that writes one colour, made to write it to every
 * target: what the fixed pipeline and an assembly program do with several
 * draw buffers.
 *
 * @param {string} code @param {number} targets
 */
function broadcast(code, targets){
    const single = '@fragment\nfn fragmentMain(input: VertexOut) -> @location(0) vec4f {';
    if (!code.includes(single))
    {
        return code;
    }
    return `${code.replace(single, 'fn fragmentColour(input: VertexOut) -> vec4f {')}
struct BroadcastOut {
${Array.from({ length: targets }, (_, k)=>`    @location(${k}) c${k}: vec4f,`).join('\n')}
};

@fragment
fn fragmentMain(input: VertexOut) -> BroadcastOut {
    let colour = fragmentColour(input);
    var out: BroadcastOut;
${Array.from({ length: targets }, (_, k)=>`    out.c${k} = colour;`).join('\n')}
    return out;
}
`;
}

/**
 * A draw under a GLSL program: its stages, and the fixed pipeline's for a
 * stage it has no shader for (OpenGL 2.0, section 2.15), the two meeting in
 * the fixed varying struct when one of them is fixed.
 *
 * @param {DrawState} state
 * @returns {{ code: string, label: string, programs: ProgramStages | null,
 *     glsl: GlslStages }}
 */
function generateGlslDraw(state){
    const label = `gl:${drawKey(state)}`;
    const program = /** @type {NonNullable<DrawState['glsl']>} */ (state.glsl).program;
    const targets = state.targets?.length ?? 1;
    /** @type {import('./glsl-wgsl.js').StageOptions} */
    const options = {
        attributes: state.attributes, flat: state.flat, twoSide: !!state.twoSide,
        alphaFunc: state.alphaFunc, targets, compare: compareExpression,
        fixed: {
            texcoords: state.units.map(unit=>unit.index),
            fog: state.fog ? fogFactorOf(state.fog) : null,
        },
    };
    /** @type {GlslStages} */
    const stages = { vertex: null, fragment: null, samplers: [] };
    /** @type {string[]} */
    const parts = [];
    try
    {
        if (program.vertex && program.fragment)
        {
            const vertex = emitStage(program, 'vertex', options, null, 'glsl');
            const fragment = emitStage(program, 'fragment', options, vertex.fields, 'glsl');
            parts.push(interfaceStruct(vertex.fields), vertex.code, fragment.code);
            stages.vertex = vertex.plan;
            stages.fragment = fragment.plan;
            stages.samplers = [...new Set([...vertex.usedSamplers, ...fragment.usedSamplers])];
            parts.unshift(...samplerDeclarations(program, stages.samplers));
        }
        else if (program.vertex)
        {
            const fixedVaryings = { texcoords: state.units.map(unit=>unit.index),
                fogCoord: false };
            const vertex = emitStage(program, 'vertex', options, null, 'fixed');
            const fragment = fixedFragment(state);
            parts.push(vertexOutStruct(fixedVaryings, state.flat, null), vertex.code,
                fragment.bindings, fragment.main);
            stages.vertex = vertex.plan;
            stages.samplers = vertex.usedSamplers;
            parts.unshift(...samplerDeclarations(program, stages.samplers));
        }
        else
        {
            const varyings = {
                texcoords: Array.from({ length: VARYING_TEXCOORDS }, (unused, set)=>set),
                fogCoord: true,
            };
            const fragment = emitStage(program, 'fragment', options, null, 'fixed');
            parts.push(fixedVertexIn(state), vertexOutStruct(varyings, state.flat, null),
                SPHERE_MAP_FN, state.lighting ? lightingFunction(state.lighting) : '',
                fixedVertexMain({ ...state, clip: null }, varyings), fragment.code);
            stages.fragment = fragment.plan;
            stages.samplers = fragment.usedSamplers;
            parts.unshift(...samplerDeclarations(program, stages.samplers));
        }
    }
    catch (e){
        return { code: '', label, programs: { vertex: null, fragment: null,
            error: e instanceof Error ? e.message : String(e) }, glsl: stages };
    }
    const vertexIn = program.vertex ? fixedVertexIn(state) : '';
    const code = `diagnostic(off, derivative_uniformity);
${UNIFORM_STRUCT}
${vertexIn}
${parts.join('\n\n')}
`;
    return { code, label, programs: null, glsl: stages };
}

/**
 * @typedef {Object} GlslStages
 * @property {import('./glsl-wgsl.js').BlockPlan | null} vertex
 * @property {import('./glsl-wgsl.js').BlockPlan | null} fragment
 * @property {number[]} samplers  the program's samplers the stages sample, by index
 */

/**
 * The texture and sampler bindings of the samplers a program's stages read.
 *
 * @param {import('./glsl-link.js').LinkedProgram} program @param {number[]} used
 * @returns {string[]}
 */
function samplerDeclarations(program, used){
    return [...used].sort((a, b)=>a - b).map(index=>{
        const sampler = program.samplers[index];
        const kind = sampler.dim === 'Cube' ? 'texture_cube<f32>' : 'texture_2d<f32>';
        return `@group(0) @binding(${1 + index * 2}) var glt${index}: ${kind};
@group(0) @binding(${2 + index * 2}) var gls${index}: sampler;`;
    });
}

/**
 * The fixed pipeline's draw: both stages generated from the state.
 *
 * @param {DrawState} state
 * @returns {{ code: string, label: string, programs: ProgramStages | null }}
 */
function generateFixedDraw(state){
    const varyings = { texcoords: state.units.map(unit=>unit.index), fogCoord: false };
    const fragment = fixedFragment(state);
    const code = `${state.clip?.distances ? 'enable clip_distances;\n' : ''}${UNIFORM_STRUCT}${
        fragment.bindings}

${fixedVertexIn(state)}

${vertexOutStruct(varyings, state.flat, state.clip ?? null)}

${SPHERE_MAP_FN}
${state.lighting ? lightingFunction(state.lighting) : ''}

${fixedVertexMain(state, varyings)}

${fragment.main}
`;
    return { code, label: `gl:${drawKey(state)}`, programs: null };
}

/**
 * @typedef {Object} ProgramStages
 *     What the two program uniform blocks carry, per stage.
 * @property {import('./arb-wgsl.js').StageNeeds | null} vertex
 * @property {import('./arb-wgsl.js').StageNeeds | null} fragment
 * @property {string | null} error  why no module could be generated
 */

/**
 * A draw under a program: each stage is the emitted one where a program is
 * enabled and bound, the fixed one where it is not, and both share the fixed
 * uniform block and one varying struct.
 *
 * @param {DrawState} state
 * @returns {{ code: string, label: string, programs: ProgramStages }}
 */
function generateProgramDraw(state){
    const label = `gl:${drawKey(state)}`;
    /** @param {string} error */
    const refused = error=>({
        code: '', label, programs: { vertex: null, fragment: null, error },
    });

    const fragmentStage = state.fragmentProgram
        ? emitFragment(state.fragmentProgram.ir, FRAGMENT_PROGRAM_GROUP,
            state.viewportHeight ?? 0)
        : null;
    if (fragmentStage && 'error' in fragmentStage)
    {
        return refused(fragmentStage.error);
    }
    // A program stage reads and writes any coordinate set up to what the
    // varyings carry, and a fragment program reads the raw fog coordinate;
    // a fixed fragment reads only what its enabled units use. A vertex
    // program that writes result.fogcoord needs the raw coordinate's varying
    // even when the fragment stage is the fixed one.
    const vertexOnly = state.vertexProgram && !state.fragmentProgram
        ? needsOf(state.vertexProgram.ir)
        : null;
    const varyings = state.fragmentProgram || state.vertexProgram
        ? {
            texcoords: Array.from({ length: VARYING_TEXCOORDS }, (unused, set)=>set),
            fogCoord: state.fragmentProgram !== null
                || (vertexOnly !== null && 'needs' in vertexOnly
                    && vertexOnly.needs.writesFogCoord),
        }
        : { texcoords: state.units.map(unit=>unit.index), fogCoord: false };
    const inputs = state.attributes.map(attribute=>({
        name: attribute.name, components: attribute.components, scalar: attribute.scalar,
    }));
    const vertexStage = state.vertexProgram
        ? emitVertex(state.vertexProgram.ir, inputs, varyings)
        : null;
    if (vertexStage && 'error' in vertexStage)
    {
        return refused(vertexStage.error);
    }

    const vertexCode = vertexStage
        ? vertexStage.code
        : `${fixedVertexIn(state)}

${vertexOutStruct(varyings, state.flat, state.clip ?? null)}

${SPHERE_MAP_FN}
${state.lighting ? lightingFunction(state.lighting) : ''}

${fixedVertexMain(state, varyings)}
`;
    const fragmentCode = fragmentStage
        ? fragmentStage.code
        : `${fixedFragment(state).bindings}

${fixedFragment(state).main}
`;
    const code = `${state.clip?.distances ? 'enable clip_distances;\n' : ''}${UNIFORM_STRUCT}
${vertexCode}
${fragmentCode}`;
    return {
        code,
        label,
        programs: {
            vertex: vertexStage ? vertexStage.needs : null,
            fragment: fragmentStage ? fragmentStage.needs : null,
            error: null,
        },
    };
}

/**
 * The colour, depth-stencil and primitive parts of a pipeline descriptor,
 * with the vertex buffers laid out per slot. The caller adds the modules
 * and the layout, which it owns.
 *
 * @param {DrawState} state
 * @returns {any}
 */
export function drawDescriptor(state){
    /** @type {any[]} */
    const buffers = state.strides.map((stride, slot)=>({
        arrayStride: stride,
        stepMode: 'vertex',
        attributes: state.attributes
            .map((attribute, location)=>({ attribute, location }))
            .filter(({ attribute })=>attribute.slot === slot)
            .map(({ attribute, location })=>({
                shaderLocation: location,
                offset: attribute.offset,
                format: attribute.format,
            })),
    }));
    const blend = state.blend ? blendStateOf(state.blend) : undefined;
    /** @param {DrawState['stencil']} sideState */
    const stencilFace = sideState=>(sideState
        ? {
            compare: lookUp(COMPARE, sideState.func, 'stencil function'),
            failOp: lookUp(STENCIL_OP, sideState.fail, 'stencil operation'),
            depthFailOp: lookUp(STENCIL_OP, sideState.zfail, 'stencil operation'),
            passOp: lookUp(STENCIL_OP, sideState.zpass, 'stencil operation'),
        }
        : { compare: 'always', failOp: 'keep', depthFailOp: 'keep', passOp: 'keep' });
    const face = stencilFace(state.stencil);
    // A one-sided state (`stencilBack` absent) has no back ops of its own:
    // both faces get the front's.
    const backFace = stencilFace(state.stencilBack ?? state.stencil);
    const targets = (state.targets ?? [{ format: state.targetFormat, mask: state.colourMask }])
        .map(target=>(target.format === '' ? null
            : { format: target.format, blend, writeMask: target.mask }));
    return {
        vertexBuffers: buffers,
        target: targets[0],
        targets,
        primitive: {
            topology: state.topology,
            cullMode: state.cull,
            frontFace: state.frontIsCcw ? 'ccw' : 'cw',
        },
        depthStencil: state.depthFormat === '' ? undefined : {
            format: state.depthFormat,
            depthCompare: state.depth.test
                ? lookUp(COMPARE, state.depth.func, 'depth function')
                : 'always',
            depthWriteEnabled: state.depth.write,
            stencilFront: face,
            stencilBack: backFace,
            // WebGPU has one read mask and one write mask for both faces; the
            // front's own are exact for a program whose two faces agree, and
            // `gpu.js` reports a divergence once when they do not.
            stencilReadMask: state.stencil ? state.stencil.readMask : 0xff,
            stencilWriteMask: state.stencil ? state.stencil.writeMask : 0,
            // GL's units are multiples of the smallest resolvable difference,
            // which is what WebGPU's constant bias counts in too.
            depthBias: state.polygonOffset ? Math.round(state.polygonOffset.units) : 0,
            depthBiasSlopeScale: state.polygonOffset ? state.polygonOffset.factor : 0,
            depthBiasClamp: 0,
        },
        multisample: { count: 1 },
    };
}

/**
 * A GL blend state as WebGPU's: separate factors and equations, a MIN or MAX
 * equation taking no factors (WebGPU wants them one).
 *
 * @param {NonNullable<DrawState['blend']>} blend
 */
function blendStateOf(blend){
    /** @param {number} src @param {number} dst @param {number} equation */
    const component = (src, dst, equation)=>{
        const operation = lookUp(BLEND_OPERATION, equation ?? GL.FUNC_ADD, 'blend equation');
        const minMax = operation === 'min' || operation === 'max';
        return {
            srcFactor: minMax ? 'one' : lookUp(BLEND_FACTOR, src, 'source blend'),
            dstFactor: minMax ? 'one' : lookUp(BLEND_FACTOR, dst, 'destination blend'),
            operation,
        };
    };
    return {
        color: component(blend.src, blend.dst, blend.equation ?? GL.FUNC_ADD),
        alpha: component(blend.srcAlpha ?? blend.src, blend.dstAlpha ?? blend.dst,
            blend.equationAlpha ?? GL.FUNC_ADD),
    };
}

/**
 * @typedef {Object} ClearState
 *     What a clear draw writes. Every field is in its key.
 * @property {string} targetFormat
 * @property {string} depthFormat
 * @property {number} colourMask   zero when the colour buffer is not cleared
 * @property {boolean} depth
 * @property {number} stencilMask  zero when the stencil buffer is not cleared
 * @property {{ format: string, mask: number }[]} [targets]  a framebuffer
 *           object's draw buffers, each cleared in the channels it has
 */

/** The clear's own uniform block, in floats: colour, then depth. */
export const CLEAR_UNIFORM_FLOATS = 8;

/**
 * A clear is a draw of the whole viewport under the scissor, which is what
 * GL's clear is: an attachment's load operation clears everything and ignores
 * the scissor, the write masks and the depth mask, and GL honours all of
 * them. One triangle covers the target; depth is the clear value, stencil
 * replaces with the reference the pass carries.
 *
 * @param {ClearState} state
 */
export function clearKey(state){
    return `clear|${state.targetFormat}|${state.depthFormat}|${state.colourMask}|`
        + `${state.depth ? 1 : 0}|${state.stencilMask}|${targetsKey(state.targets)}`;
}

/**
 * @param {number} [targets]  the colour targets written, each the clear colour
 * @returns {{ code: string, label: string }}
 */
export function generateClear(targets = 1){
    if (targets > 1)
    {
        const single = generateClear(1).code.replace(
            '@fragment\nfn fragmentMain() -> @location(0) vec4f {', 'fn clearColour() -> vec4f {');
        return { label: `gl:clear${targets}`, code: `${single}
struct ClearOut {
${Array.from({ length: targets }, (_, k)=>`    @location(${k}) c${k}: vec4f,`).join('\n')}
};

@fragment
fn fragmentMain() -> ClearOut {
    var out: ClearOut;
${Array.from({ length: targets }, (_, k)=>`    out.c${k} = clearColour();`).join('\n')}
    return out;
}
` };
    }
    const code = `struct ClearUniforms {
    color: vec4f,
    depth: vec4f,
};
@group(0) @binding(0) var<uniform> uniforms: ClearUniforms;

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    let x = f32(index & 1u) * 4.0 - 1.0;
    let y = f32((index >> 1u) & 1u) * 4.0 - 1.0;
    return vec4f(x, y, uniforms.depth.x, 1.0);
}

@fragment
fn fragmentMain() -> @location(0) vec4f {
    return uniforms.color;
}
`;
    return { code, label: 'gl:clear' };
}

/**
 * The frame shown is a copy of the one drawn with every pixel opaque. GL's
 * back buffer carries a real alpha channel that programs blend against, and a
 * page composites a presented texture by its alpha: shown as it is, a frame
 * whose destination alpha a program used as scratch shows the page through
 * it. The copy is a draw of one triangle over the target.
 *
 * @param {string} targetFormat
 */
export function showKey(targetFormat){
    return `show|${targetFormat}`;
}

/** @returns {{ code: string, label: string }} */
export function generateShow(){
    const code = `struct ShowUniforms {
    unused: vec4f,
};
@group(0) @binding(0) var<uniform> uniforms: ShowUniforms;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;

struct ShowVertex {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> ShowVertex {
    var out: ShowVertex;
    let x = f32(index & 1u) * 4.0 - 1.0;
    let y = f32((index >> 1u) & 1u) * 4.0 - 1.0;
    out.position = vec4f(x, y, 0.0, 1.0);
    out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return out;
}

@fragment
fn fragmentMain(input: ShowVertex) -> @location(0) vec4f {
    let unused = uniforms.unused;
    return vec4f(textureSample(sourceTexture, sourceSampler, input.uv).rgb, 1.0);
}
`;
    return { code, label: 'gl:show' };
}

/**
 * A copy from the framebuffer into a texture level is a draw into that level
 * that samples the back buffer, because the two differ in row order: GL
 * counts framebuffer rows from the bottom and texture rows from the first
 * one given, and a plain copy would put the picture in upside down. The
 * fragment's own position says which texel it is; the uniforms say which
 * framebuffer pixel that texel takes.
 *
 * @param {string} targetFormat
 */
export function copyKey(targetFormat){
    return `copy|${targetFormat}`;
}

/**
 * The copy's uniform block, in floats: x, y, xoffset, yoffset; then the
 * source's size and row order (1 the window's, -1 a framebuffer object's).
 */
export const COPY_UNIFORM_FLOATS = 8;

/** @returns {{ code: string, label: string }} */
export function generateCopy(){
    const code = `struct CopyUniforms {
    rect: vec4f,
    size: vec4f,
};
@group(0) @binding(0) var<uniform> uniforms: CopyUniforms;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    let x = f32(index & 1u) * 4.0 - 1.0;
    let y = f32((index >> 1u) & 1u) * 4.0 - 1.0;
    return vec4f(x, y, 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let k = position.xy - uniforms.rect.zw;
    let u = (uniforms.rect.x + k.x) / uniforms.size.x;
    let row = uniforms.rect.y + k.y;
    let v = select(row, uniforms.size.y - row, uniforms.size.z > 0.0) / uniforms.size.y;
    return textureSample(sourceTexture, sourceSampler, vec2f(u, v));
}
`;
    return { code, label: 'gl:copy' };
}

/**
 * glBlitFramebuffer: a rectangle of one target drawn into a rectangle of
 * another, scaled, each in GL's window coordinates and each target with its
 * own row order. A pixel of the destination finds its place in the
 * destination rectangle, the same place in the source rectangle, and the
 * source texel there; a rectangle given right to left or top to bottom
 * mirrors.
 *
 * @param {string} targetFormat
 */
export function blitKey(targetFormat){
    return `blit|${targetFormat}`;
}

/**
 * The blit's uniform block, in floats: the source rectangle's corners, the
 * destination's; then the source's size and row order, and the
 * destination's.
 */
export const BLIT_UNIFORM_FLOATS = 16;

/** @returns {{ code: string, label: string }} */
export function generateBlit(){
    const code = `struct BlitUniforms {
    source: vec4f,
    destination: vec4f,
    sourceSize: vec4f,
    destinationSize: vec4f,
};
@group(0) @binding(0) var<uniform> uniforms: BlitUniforms;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    let x = f32(index & 1u) * 4.0 - 1.0;
    let y = f32((index >> 1u) & 1u) * 4.0 - 1.0;
    return vec4f(x, y, 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let height = uniforms.destinationSize.y;
    let window = vec2f(position.x,
        select(position.y, height - position.y, uniforms.destinationSize.z > 0.0));
    let span = uniforms.destination.zw - uniforms.destination.xy;
    let t = (window - uniforms.destination.xy) / span;
    let at = uniforms.source.xy + t * (uniforms.source.zw - uniforms.source.xy);
    let size = uniforms.sourceSize.xy;
    let v = select(at.y, size.y - at.y, uniforms.sourceSize.z > 0.0) / size.y;
    return textureSampleLevel(sourceTexture, sourceSampler, vec2f(at.x / size.x, v), 0.0);
}
`;
    return { code, label: 'gl:blit' };
}

/**
 * @param {string} targetFormat
 * @returns {any}
 */
export function showDescriptor(targetFormat){
    return {
        vertexBuffers: [],
        target: { format: targetFormat, blend: undefined, writeMask: 0xf },
        primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
        depthStencil: undefined,
        multisample: { count: 1 },
    };
}

/**
 * @param {ClearState} state
 * @returns {any}
 */
export function clearDescriptor(state){
    const face = {
        compare: 'always',
        failOp: 'keep',
        depthFailOp: 'keep',
        passOp: state.stencilMask !== 0 ? 'replace' : 'keep',
    };
    const targets = (state.targets ?? [{ format: state.targetFormat, mask: state.colourMask }])
        .map(target=>(target.format === '' ? null
            : { format: target.format, blend: undefined, writeMask: target.mask }));
    return {
        vertexBuffers: [],
        target: targets[0],
        targets,
        primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
        depthStencil: state.depthFormat === '' ? undefined : {
            format: state.depthFormat,
            depthCompare: 'always',
            depthWriteEnabled: state.depth,
            stencilFront: face,
            stencilBack: face,
            stencilReadMask: 0xff,
            stencilWriteMask: state.stencilMask,
            depthBias: 0,
            depthBiasSlopeScale: 0,
            depthBiasClamp: 0,
        },
        multisample: { count: 1 },
    };
}
