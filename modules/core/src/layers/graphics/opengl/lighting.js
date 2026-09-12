/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The fixed-function lighting equation, per vertex, in eye coordinates.
 *
 * It is evaluated in floating point and clamped once at the end, which is
 * how the specification writes it and how the hardware of the era computed
 * it; quantising the terms would disagree with both by a level in places.
 *
 * Two things about the inputs are contract and are easy to miss:
 *
 * - **A light's position is fixed in eye space when it is set**, by the
 *   modelview matrix current at that moment. A program that sets its light
 *   before its camera transform gets a headlamp; one that sets it after gets
 *   a lamp in the world. Both are right, and the difference is entirely in
 *   when `glLight` was called -- so the transform happens at the call, and the
 *   record here already holds eye coordinates.
 * - **The normal goes through the inverse transpose of the modelview**, not
 *   the modelview. For a rotation the two agree, which is why a wrong
 *   implementation looks fine until the first non-uniform scale.
 */

import { GL } from './constants.js';

/**
 * @typedef {Object} Light
 * @property {number[]} ambient   r, g, b, a
 * @property {number[]} diffuse
 * @property {number[]} specular
 * @property {number[]} position  eye coordinates, homogeneous
 * @property {number[]} spotDirection  eye coordinates
 * @property {number} spotExponent
 * @property {number} spotCutoff   degrees; 180 means no cone
 * @property {number} constantAttenuation
 * @property {number} linearAttenuation
 * @property {number} quadraticAttenuation
 */

/**
 * @typedef {Object} Material
 * @property {number[]} ambient
 * @property {number[]} diffuse
 * @property {number[]} specular
 * @property {number[]} emission
 * @property {number} shininess
 */

/**
 * @typedef {Object} LightModel
 * @property {number[]} ambient
 * @property {boolean} localViewer
 * @property {boolean} separateSpecular
 */

/**
 * @param {number} index  0..7
 * @returns {Light} the default of GL_LIGHT0 + index
 */
export function createLight(index){
    // Only the first light starts white; the rest are black until a program
    // colours them, which is the specification's way of making GL_LIGHT0
    // usable with no setup at all.
    const on = index === 0 ? 1 : 0;
    return {
        ambient: [0, 0, 0, 1],
        diffuse: [on, on, on, 1],
        specular: [on, on, on, 1],
        position: [0, 0, 1, 0],
        spotDirection: [0, 0, -1],
        spotExponent: 0,
        spotCutoff: 180,
        constantAttenuation: 1,
        linearAttenuation: 0,
        quadraticAttenuation: 0,
    };
}

/** @returns {Material} */
export function createMaterial(){
    return {
        ambient: [0.2, 0.2, 0.2, 1],
        diffuse: [0.8, 0.8, 0.8, 1],
        specular: [0, 0, 0, 1],
        emission: [0, 0, 0, 1],
        shininess: 0,
    };
}

/**
 * The transpose of the inverse of a matrix's upper 3x3: what a normal is
 * transformed by.
 *
 * @param {ArrayLike<number>} m  column major, 16 elements
 * @returns {number[]} nine elements, column major, or the identity when the
 *          matrix is singular and no normal can be carried through it
 */
export function normalMatrix(m){
    const a = m[0];
    const b = m[4];
    const c = m[8];
    const d = m[1];
    const e = m[5];
    const f = m[9];
    const g = m[2];
    const h = m[6];
    const i = m[10];
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (det === 0)
    {
        return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    }
    // The inverse is the adjugate over the determinant, and the adjugate is
    // the cofactor matrix transposed -- so the inverse transpose is simply
    // the cofactor matrix over the determinant, laid out column by column.
    return [
        (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
        (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
        (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
    ];
}

/**
 * @param {readonly number[]} v
 * @returns {number[]} the unit vector, or the zero vector unchanged
 */
export function normalise(v){
    const length = Math.hypot(v[0], v[1], v[2]);
    return length === 0 ? [0, 0, 0] : [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * @typedef {Object} LightingInputs
 * @property {readonly number[]} position   the vertex in eye coordinates, homogeneous
 * @property {readonly number[]} normal     the vertex normal in eye coordinates
 * @property {Material} material
 * @property {LightModel} model
 * @property {readonly Light[]} lights      only the enabled ones
 */

/**
 * The lit colour of one vertex.
 *
 * @param {LightingInputs} inputs
 * @returns {{ primary: number[], secondary: number[] }} r, g, b, a in 0..1;
 *          the secondary colour is the specular term when the light model
 *          separates it and black otherwise
 */
export function lightVertex(inputs){
    const { material, model, lights } = inputs;
    const n = inputs.normal;
    const w = inputs.position[3] === 0 ? 1 : inputs.position[3];
    const v = [inputs.position[0] / w, inputs.position[1] / w, inputs.position[2] / w];

    const colour = [
        material.emission[0] + model.ambient[0] * material.ambient[0],
        material.emission[1] + model.ambient[1] * material.ambient[1],
        material.emission[2] + model.ambient[2] * material.ambient[2],
    ];
    const specular = [0, 0, 0];

    for (const light of lights)
    {
        /** @type {number[]} */
        let toLight;
        let attenuation = 1;
        if (light.position[3] === 0)
        {
            toLight = normalise(light.position);
        }
        else
        {
            const lw = light.position[3];
            const delta = [
                light.position[0] / lw - v[0],
                light.position[1] / lw - v[1],
                light.position[2] / lw - v[2],
            ];
            const distance = Math.hypot(delta[0], delta[1], delta[2]);
            toLight = normalise(delta);
            attenuation = 1 / (light.constantAttenuation
                + light.linearAttenuation * distance
                + light.quadraticAttenuation * distance * distance);
        }

        let spot = 1;
        if (light.spotCutoff !== 180)
        {
            const direction = normalise(light.spotDirection);
            const cosine = -(toLight[0] * direction[0] + toLight[1] * direction[1]
                + toLight[2] * direction[2]);
            spot = cosine < Math.cos(light.spotCutoff * Math.PI / 180)
                ? 0
                : Math.pow(Math.max(cosine, 0), light.spotExponent);
        }

        const diffuseDot = Math.max(0, n[0] * toLight[0] + n[1] * toLight[1] + n[2] * toLight[2]);
        const scale = attenuation * spot;
        for (let k = 0; k < 3; k++)
        {
            colour[k] += scale * (light.ambient[k] * material.ambient[k]
                + diffuseDot * light.diffuse[k] * material.diffuse[k]);
        }

        // Specular is switched off entirely on a surface facing away from
        // the light; without that a highlight bleeds around the terminator.
        if (diffuseDot > 0)
        {
            const eye = model.localViewer ? normalise([-v[0], -v[1], -v[2]]) : [0, 0, 1];
            const half = normalise([toLight[0] + eye[0], toLight[1] + eye[1], toLight[2] + eye[2]]);
            const specularDot = Math.max(0, n[0] * half[0] + n[1] * half[1] + n[2] * half[2]);
            const term = specularDot === 0 && material.shininess === 0
                ? 1
                : Math.pow(specularDot, material.shininess);
            for (let k = 0; k < 3; k++)
            {
                specular[k] += scale * term * light.specular[k] * material.specular[k];
            }
        }
    }

    const clamp = (/** @type {number} */ value)=>(value < 0 ? 0 : value > 1 ? 1 : value);
    const alpha = clamp(material.diffuse[3]);
    if (model.separateSpecular)
    {
        return {
            primary: [clamp(colour[0]), clamp(colour[1]), clamp(colour[2]), alpha],
            secondary: [clamp(specular[0]), clamp(specular[1]), clamp(specular[2]), 1],
        };
    }
    return {
        primary: [
            clamp(colour[0] + specular[0]), clamp(colour[1] + specular[1]),
            clamp(colour[2] + specular[2]), alpha,
        ],
        secondary: [0, 0, 0, 1],
    };
}

/**
 * Which material properties GL_COLOR_MATERIAL replaces with the current
 * colour, for a given mode.
 *
 * @param {number} mode
 * @returns {readonly ('ambient' | 'diffuse' | 'specular' | 'emission')[]}
 */
export function colourMaterialTargets(mode){
    switch (mode)
    {
        case GL.AMBIENT:
            return ['ambient'];
        case GL.DIFFUSE:
            return ['diffuse'];
        case GL.SPECULAR:
            return ['specular'];
        case GL.EMISSION:
            return ['emission'];
        default:
            return ['ambient', 'diffuse'];
    }
}
