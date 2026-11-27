/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The values of GLSL's built-in state uniforms (the language
 * specification's section 7.5), from the context's state at a draw, written
 * into a stage's block in the slots `glsl-wgsl.js` lays them out in: a
 * scalar or a vector a vec4 slot, a matrix a slot per column, a struct its
 * members in order, an array its elements.
 *
 * The derived values are the specification's: the normal matrix is the
 * inverse transpose of the modelview's upper 3x3; a light's half vector is
 * the normalised sum of its direction and the eye's (0, 0, 1), as for an
 * infinite viewer; its spot cutoff's cosine is the cosine of the angle, -1
 * for no cone; the products are the light's and the material's components
 * multiplied; the fog scale is 1 / (end - start).
 */

import { invert, transpose } from './matrix.js';
import { normalMatrix } from './lighting.js';

/** What a matrix is when there is none to read. */
const IDENTITY = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const ZERO = new Float64Array(16);

/**
 * @param {Float32Array} out @param {number} at  a word
 * @param {ArrayLike<number>} values  up to four
 * @returns {number} the next slot's word
 */
const slot = (out, at, values)=>{
    for (let k = 0; k < 4; k++)
    {
        out[at + k] = values[k] ?? 0;
    }
    return at + 4;
};

/** @param {Float32Array} out @param {number} at @param {ArrayLike<number>} m */
const mat4 = (out, at, m)=>{
    for (let k = 0; k < 16; k++)
    {
        out[at + k] = m[k];
    }
    return at + 16;
};

/**
 * A 4x4 matrix with a modifier, as the `Inverse`, `Transpose` and
 * `InverseTranspose` names ask: a singular inverse reads as zeros.
 *
 * @param {ArrayLike<number>} m @param {string} modifier
 */
function modified(m, modifier){
    let out = m;
    if (modifier === 'Inverse' || modifier === 'InverseTranspose')
    {
        out = invert(out) ?? ZERO;
    }
    if (modifier === 'Transpose' || modifier === 'InverseTranspose')
    {
        out = transpose(out);
    }
    return out;
}

/** @param {readonly number[]} a @param {readonly number[]} b */
const times = (a, b)=>[a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]];

/**
 * @typedef {Object} StateScene
 *     What of a draw's scene the state uniforms read.
 * @property {ArrayLike<number>} modelview
 * @property {ArrayLike<number>} projection
 * @property {readonly ArrayLike<number>[]} textureMatrices
 * @property {readonly number[]} depthRange
 * @property {() => any} glslState
 */

/**
 * Writes one built-in state uniform's value at `at`.
 *
 * @param {string} name  `gl_ModelViewMatrix`, `gl_LightSource`, ...
 * @param {StateScene} scene
 * @param {ArrayLike<number>} mvp
 * @param {Float32Array} out
 * @param {number} at  the word its first slot starts at
 */
export function packState(name, scene, mvp, out, at){
    const matrix = /^gl_(ModelView|Projection|ModelViewProjection|Texture)Matrix(.*)$/
        .exec(name);
    if (matrix)
    {
        const [, which, modifier] = matrix;
        if (which === 'Texture')
        {
            for (let unit = 0; unit < 8; unit++)
            {
                at = mat4(out, at, modified(scene.textureMatrices[unit] ?? IDENTITY, modifier));
            }
            return;
        }
        const base = which === 'ModelView' ? scene.modelview
            : which === 'Projection' ? scene.projection : mvp;
        mat4(out, at, modified(base, modifier));
        return;
    }
    switch (name)
    {
        case 'gl_NormalMatrix': {
            const nm = normalMatrix(scene.modelview);
            for (let c = 0; c < 3; c++)
            {
                at = slot(out, at, [nm[c * 3], nm[c * 3 + 1], nm[c * 3 + 2]]);
            }
            return;
        }
        case 'gl_NormalScale':
            slot(out, at, [1]);
            return;
        case 'gl_DepthRange': {
            const [near, far] = scene.depthRange;
            at = slot(out, at, [near]);
            at = slot(out, at, [far]);
            slot(out, at, [far - near]);
            return;
        }
        default:
            break;
    }
    const state = scene.glslState();
    switch (name)
    {
        case 'gl_ClipPlane':
            for (const plane of state.clipPlanes)
            {
                at = slot(out, at, plane);
            }
            return;
        case 'gl_Point': {
            const p = state.point;
            for (const value of [p.size, p.min, p.max, p.fade, p.attenuation[0],
                p.attenuation[1], p.attenuation[2]])
            {
                at = slot(out, at, [value]);
            }
            return;
        }
        case 'gl_FrontMaterial':
        case 'gl_BackMaterial': {
            const m = name === 'gl_FrontMaterial' ? state.materials.front : state.materials.back;
            for (const value of [m.emission, m.ambient, m.diffuse, m.specular])
            {
                at = slot(out, at, value);
            }
            slot(out, at, [m.shininess]);
            return;
        }
        case 'gl_LightSource':
            for (const light of state.lights)
            {
                const p = light.position;
                const direction = p[3] === 0 ? [p[0], p[1], p[2]] : [-p[0], -p[1], -p[2]];
                const length = Math.hypot(...direction) || 1;
                const half = [direction[0] / length, direction[1] / length,
                    direction[2] / length + 1];
                const halfLength = Math.hypot(...half) || 1;
                at = slot(out, at, light.ambient);
                at = slot(out, at, light.diffuse);
                at = slot(out, at, light.specular);
                at = slot(out, at, p);
                at = slot(out, at, [half[0] / halfLength, half[1] / halfLength,
                    half[2] / halfLength, 0]);
                at = slot(out, at, light.spotDirection);
                at = slot(out, at, [light.spotExponent]);
                at = slot(out, at, [light.spotCutoff]);
                at = slot(out, at, [light.spotCutoff === 180 ? -1
                    : Math.cos(light.spotCutoff * Math.PI / 180)]);
                at = slot(out, at, [light.constantAttenuation]);
                at = slot(out, at, [light.linearAttenuation]);
                at = slot(out, at, [light.quadraticAttenuation]);
            }
            return;
        case 'gl_LightModel':
            slot(out, at, state.lightModelAmbient);
            return;
        case 'gl_FrontLightModelProduct':
        case 'gl_BackLightModelProduct': {
            const m = name.startsWith('gl_Front') ? state.materials.front : state.materials.back;
            const ambient = times(state.lightModelAmbient, m.ambient);
            slot(out, at, [m.emission[0] + ambient[0], m.emission[1] + ambient[1],
                m.emission[2] + ambient[2], m.diffuse[3]]);
            return;
        }
        case 'gl_FrontLightProduct':
        case 'gl_BackLightProduct': {
            const m = name.startsWith('gl_Front') ? state.materials.front : state.materials.back;
            for (const light of state.lights)
            {
                at = slot(out, at, times(light.ambient, m.ambient));
                at = slot(out, at, times(light.diffuse, m.diffuse));
                at = slot(out, at, times(light.specular, m.specular));
            }
            return;
        }
        case 'gl_TextureEnvColor':
            for (let unit = 0; unit < 4; unit++)
            {
                at = slot(out, at, state.units[unit]?.envColour ?? [0, 0, 0, 0]);
            }
            return;
        case 'gl_Fog': {
            const fog = state.fog;
            at = slot(out, at, fog.colour);
            at = slot(out, at, [fog.density]);
            at = slot(out, at, [fog.start]);
            at = slot(out, at, [fog.end]);
            slot(out, at, [fog.end === fog.start ? 0 : 1 / (fog.end - fog.start)]);
            return;
        }
        default:
            break;
    }
    const plane = /^gl_(Eye|Object)Plane([STRQ])$/.exec(name);
    if (plane)
    {
        const k = 'STRQ'.indexOf(plane[2]);
        for (let unit = 0; unit < 8; unit++)
        {
            const planes = state.units[unit]?.[plane[1] === 'Eye' ? 'eyePlanes' : 'objectPlanes'];
            at = slot(out, at, planes?.[k] ?? [0, 0, 0, 0]);
        }
    }
}

/** The state uniforms a block holding only these can be kept for while the matrices stay. */
export const MATRIX_STATE = /^gl_(ModelView|Projection|ModelViewProjection)Matrix|gl_NormalMatrix$|^gl_DepthRange$|^gl_NormalScale$/;
