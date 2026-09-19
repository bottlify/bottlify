/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * From a primitive's vertices to fragments: the fixed-function pipeline
 * between glEnd and the framebuffer.
 *
 * Everything the context has to say about a draw arrives in one `Scene`,
 * read once per primitive: the matrices, the lights, the fog, the texture
 * units, the fragment tests. This file does not know what a context is, so
 * the whole pipeline can be exercised from a test that builds a scene by hand
 * -- and so the context's entry points stay about state, not arithmetic.
 *
 * The stages are the specification's, in its order:
 *
 * 1. **Per vertex**: eye coordinates, the lit colour if lighting is on, the
 *    fog factor, the texture coordinates through generation and the texture
 *    matrix, then clip coordinates.
 * 2. **Clipping** against the near and far planes and the user clip planes,
 *    in clip space where attributes are still linear. Left, right, top and
 *    bottom are left to the rasteriser's bounds: a triangle that overhangs
 *    the window costs nothing there, and clipping it would only invent
 *    vertices.
 * 3. **Division and the viewport**, giving window coordinates, with depth
 *    mapped through the depth range.
 * 4. **Assembly** into polygons, lines and points, with face culling and the
 *    polygon mode applied per polygon -- a quad drawn as lines is four edges,
 *    not two triangles' six.
 * 5. **Rasterisation**, and per fragment the texture environment, the colour
 *    sum, fog and the alpha test before the framebuffer operations.
 *
 * Flat shading picks the provoking vertex the specification names, which is
 * the last vertex of every primitive except a polygon's, which is its first.
 */

import { GL } from './constants.js';
import { lightVertex, normalise } from './lighting.js';
import { transform } from './matrix.js';
import { rasterLine, rasterPoint, rasterTriangle, toByte, writeFragment } from './raster.js';
import { applyTextureEnvironment, cubeFaceOf, sample2D } from './texture.js';

/**
 * @typedef {Object} PipelineVertex
 * @property {readonly number[]} position   object coordinates, homogeneous
 * @property {readonly number[]} color      r, g, b, a in 0..1
 * @property {readonly number[]} secondary  r, g, b, a in 0..1
 * @property {readonly number[]} normal
 * @property {readonly (readonly number[])[]} texCoords  s, t, r, q per unit
 * @property {number} fogCoord
 */

/**
 * @typedef {Object} TextureGeneration
 * @property {(number | null)[]} modes   per coordinate s, t, r, q; null when
 *           that coordinate is not generated
 * @property {(readonly number[])[]} objectPlanes
 * @property {(readonly number[])[]} eyePlanes
 */

/**
 * @typedef {Object} SceneUnit
 * @property {number} index  which texture coordinate set it reads
 * @property {import('./objects.js').TextureObject} texture   the object bound,
 *           for a renderer that keeps a copy of it elsewhere
 * @property {import('./texture.js').TexelImage[]} images  one, or six for a cube map
 * @property {boolean} cube
 * @property {number} baseFormat
 * @property {import('./texture.js').SamplerParameters} parameters
 * @property {import('./texture.js').TextureEnvironment} env
 * @property {ArrayLike<number>} matrix
 * @property {TextureGeneration | null} generation
 */

/**
 * @typedef {Object} SceneLighting
 * @property {import('./lighting.js').Material} material
 * @property {import('./lighting.js').LightModel} model
 * @property {readonly import('./lighting.js').Light[]} lights
 * @property {readonly number[]} normalMatrix
 * @property {boolean} normalise
 * @property {readonly ('ambient' | 'diffuse' | 'specular' | 'emission')[] | null} colourMaterial
 */

/**
 * @typedef {Object} SceneFog
 * @property {number} mode
 * @property {number} density
 * @property {number} start
 * @property {number} end
 * @property {readonly number[]} colour  0..1
 * @property {boolean} fromCoordinate
 */

/**
 * @typedef {Object} SceneStencil
 * @property {number} func
 * @property {number} reference
 * @property {number} readMask
 * @property {number} writeMask
 * @property {number} fail
 * @property {number} zfail
 * @property {number} zpass
 */

/**
 * @typedef {Object} SceneProgram
 *     One stage's bound, loaded program, as the renderer reads it.
 * @property {number} name
 * @property {number} version  raised on every load, so a re-specified program
 *           is a different pipeline
 * @property {string} text  the program string, for a dump to print once
 * @property {import('./arb-program.js').ParsedProgram} ir
 * @property {Float32Array} local   the object's local parameters
 * @property {number} localVersion  raised only when a local parameter write
 *           actually changes a value, never on one that repeats it
 * @property {Float32Array} env     the target's environment parameters
 * @property {number} envVersion    raised only when an environment parameter
 *           write actually changes a value, never on one that repeats it
 */

/**
 * @typedef {Object} Scene
 * @property {ArrayLike<number>} modelview
 * @property {ArrayLike<number>} projection
 * @property {readonly number[]} viewport   x, y, width, height
 * @property {readonly number[]} depthRange
 * @property {import('./raster.js').Framebuffer} framebuffer
 * @property {import('./raster.js').Box} scissor
 * @property {readonly (readonly number[])[]} clipPlanes  eye space, enabled only
 * @property {SceneLighting | null} lighting
 * @property {SceneFog | null} fog
 * @property {readonly SceneUnit[]} units  the enabled, complete texture units
 * @property {PipelineVertex} current   the current attributes, for an array that is off
 * @property {{ src: number, dst: number } | null} blend   the factors, when blending is on
 * @property {SceneStencil | null} stencil   when the stencil test is on
 * @property {SceneStencil | null} stencilBack   GL_EXT_stencil_two_side's back-face
 *           record, present exactly when `stencil` is -- and equal to it whenever
 *           two-sided stencil testing (`GL_STENCIL_TEST_TWO_SIDE_EXT`) is off, per the
 *           extension's "front for all fragments" rule for a disabled test
 * @property {{ factor: number, units: number } | null} polygonOffset   when filled
 *           polygons are offset
 * @property {boolean} colourSum
 * @property {{ mode: number, frontIsCcw: boolean } | null} cull
 * @property {boolean} frontIsCcw
 * @property {boolean} flat
 * @property {readonly number[]} polygonMode  front, back
 * @property {number} pointSize
 * @property {{ func: number, reference: number } | null} alphaTest
 * @property {import('./raster.js').FragmentOperations} operations
 * @property {{ vertex: SceneProgram | null, fragment: SceneProgram | null }} programs
 *           the enabled, loaded programs; null per stage when that stage is fixed
 * @property {readonly (readonly number[])[]} genericAttribs  the current
 *           generic vertex attribute values, by attribute number
 * @property {readonly (ArrayLike<number> | null)[]} textureMatrices  the texture
 *           matrix of each unit, whether or not it is enabled
 * @property {readonly { twoD: import('./objects.js').TextureObject | null,
 *             cube: import('./objects.js').TextureObject | null }[]} boundTextures
 *           what each unit has bound per target, whether or not it is enabled,
 *           which is what a fragment program samples
 */

/** Where each attribute sits in the interpolated vector. */
const SECONDARY = 0;
const FOG = 4;
const TEXTURE = 5;

/**
 * @param {number} func
 * @param {number} value
 * @param {number} reference
 * @returns {boolean}
 */
export function compare(func, value, reference){
    switch (func)
    {
        case GL.NEVER:
            return false;
        case GL.LESS:
            return value < reference;
        case GL.EQUAL:
            return value === reference;
        case GL.LEQUAL:
            return value <= reference;
        case GL.GREATER:
            return value > reference;
        case GL.NOTEQUAL:
            return value !== reference;
        case GL.GEQUAL:
            return value >= reference;
        default:
            return true;
    }
}

/**
 * The fog factor of a vertex at eye distance `c`.
 *
 * @param {SceneFog} fog
 * @param {number} c
 * @returns {number} 0..1, one being unfogged
 */
export function fogFactor(fog, c){
    /** @type {number} */
    let f;
    switch (fog.mode)
    {
        case GL.LINEAR:
            f = fog.end === fog.start ? 1 : (fog.end - c) / (fog.end - fog.start);
            break;
        case GL.EXP2:
            f = Math.exp(-(fog.density * c) * (fog.density * c));
            break;
        default:
            f = Math.exp(-fog.density * c);
            break;
    }
    return f < 0 ? 0 : f > 1 ? 1 : f;
}

/**
 * @typedef {Object} ClipVertex
 * @property {number[]} clip
 * @property {number[]} eye
 * @property {number[]} colour  0..1
 * @property {number[]} attributes
 */

/**
 * A vertex's texture coordinates for one unit, generated where the unit
 * says so and put through its matrix.
 *
 * @param {SceneUnit} unit
 * @param {PipelineVertex} vertex
 * @param {readonly number[]} eye
 * @param {readonly number[]} eyeNormal
 * @returns {number[]}
 */
function textureCoordinates(unit, vertex, eye, eyeNormal){
    const given = vertex.texCoords[unit.index] ?? [0, 0, 0, 1];
    const coords = [given[0], given[1], given[2], given[3]];
    const generation = unit.generation;
    if (generation)
    {
        /** @type {number[] | null} */
        let sphere = null;
        /** @type {number[] | null} */
        let reflection = null;
        for (let k = 0; k < 4; k++)
        {
            const mode = generation.modes[k];
            if (mode === null)
            {
                continue;
            }
            if (mode === GL.OBJECT_LINEAR)
            {
                const plane = generation.objectPlanes[k];
                coords[k] = plane[0] * vertex.position[0] + plane[1] * vertex.position[1]
                    + plane[2] * vertex.position[2] + plane[3] * vertex.position[3];
            }
            else if (mode === GL.EYE_LINEAR)
            {
                const plane = generation.eyePlanes[k];
                coords[k] = plane[0] * eye[0] + plane[1] * eye[1] + plane[2] * eye[2]
                    + plane[3] * eye[3];
            }
            else if (mode === GL.SPHERE_MAP)
            {
                if (!sphere)
                {
                    sphere = sphereMap(eye, eyeNormal);
                }
                coords[k] = k === 0 ? sphere[0] : k === 1 ? sphere[1] : coords[k];
            }
            else if (mode === GL.REFLECTION_MAP || mode === GL.NORMAL_MAP)
            {
                if (!reflection)
                {
                    reflection = mode === GL.NORMAL_MAP
                        ? [...eyeNormal]
                        : reflect(eye, eyeNormal);
                }
                coords[k] = k < 3 ? reflection[k] : coords[k];
            }
        }
    }
    return transform(unit.matrix, coords);
}

/**
 * @param {readonly number[]} eye
 * @param {readonly number[]} n
 * @returns {number[]} the reflection of the eye direction about the normal
 */
function reflect(eye, n){
    const w = eye[3] === 0 ? 1 : eye[3];
    const u = normalise([eye[0] / w, eye[1] / w, eye[2] / w]);
    const dot = u[0] * n[0] + u[1] * n[1] + u[2] * n[2];
    return [u[0] - 2 * n[0] * dot, u[1] - 2 * n[1] * dot, u[2] - 2 * n[2] * dot];
}

/**
 * @param {readonly number[]} eye
 * @param {readonly number[]} n
 * @returns {number[]} s, t
 */
function sphereMap(eye, n){
    const r = reflect(eye, n);
    const m = 2 * Math.sqrt(r[0] * r[0] + r[1] * r[1] + (r[2] + 1) * (r[2] + 1));
    return m === 0 ? [0.5, 0.5] : [r[0] / m + 0.5, r[1] / m + 0.5];
}

/**
 * Stage one: everything that happens to a vertex on its own.
 *
 * @param {Scene} scene
 * @param {PipelineVertex} vertex
 * @returns {ClipVertex}
 */
function processVertex(scene, vertex){
    const eye = transform(scene.modelview, vertex.position);
    const clip = transform(scene.projection, eye);

    /** @type {number[]} */
    let eyeNormal = [0, 0, 1];
    const lighting = scene.lighting;
    if (lighting || scene.units.some(unit=>unit.generation))
    {
        const nm = lighting?.normalMatrix ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
        const n = vertex.normal;
        eyeNormal = [
            nm[0] * n[0] + nm[3] * n[1] + nm[6] * n[2],
            nm[1] * n[0] + nm[4] * n[1] + nm[7] * n[2],
            nm[2] * n[0] + nm[5] * n[1] + nm[8] * n[2],
        ];
        if (!lighting || lighting.normalise)
        {
            eyeNormal = normalise(eyeNormal);
        }
    }

    let colour = [...vertex.color];
    let secondary = [...vertex.secondary];
    if (lighting)
    {
        let material = lighting.material;
        if (lighting.colourMaterial)
        {
            material = { ...material };
            for (const property of lighting.colourMaterial)
            {
                material[property] = [...vertex.color];
            }
        }
        const lit = lightVertex({
            position: eye, normal: eyeNormal, material, model: lighting.model,
            lights: lighting.lights,
        });
        colour = lit.primary;
        if (lighting.model.separateSpecular)
        {
            secondary = lit.secondary;
        }
    }

    let fog = 1;
    if (scene.fog)
    {
        const w = eye[3] === 0 ? 1 : eye[3];
        const c = scene.fog.fromCoordinate ? vertex.fogCoord : Math.abs(eye[2] / w);
        fog = fogFactor(scene.fog, c);
    }

    const attributes = [...secondary, fog];
    for (const unit of scene.units)
    {
        attributes.push(...textureCoordinates(unit, vertex, eye, eyeNormal));
    }
    return { clip, eye, colour, attributes };
}

/**
 * @param {ClipVertex} a
 * @param {ClipVertex} b
 * @param {number} t
 * @returns {ClipVertex}
 */
function lerpVertex(a, b, t){
    const mix = (/** @type {readonly number[]} */ p, /** @type {readonly number[]} */ q)=>
        p.map((value, index)=>value + (q[index] - value) * t);
    return {
        clip: mix(a.clip, b.clip),
        eye: mix(a.eye, b.eye),
        colour: mix(a.colour, b.colour),
        attributes: mix(a.attributes, b.attributes),
    };
}

/**
 * The planes a primitive is clipped against, each as a signed distance
 * function that is non-negative inside.
 *
 * @param {Scene} scene
 * @returns {((vertex: ClipVertex) => number)[]}
 */
function clipDistances(scene){
    /** @type {((vertex: ClipVertex) => number)[]} */
    const planes = [
        vertex=>vertex.clip[2] + vertex.clip[3],
        vertex=>vertex.clip[3] - vertex.clip[2],
    ];
    for (const plane of scene.clipPlanes)
    {
        planes.push(vertex=>plane[0] * vertex.eye[0] + plane[1] * vertex.eye[1]
            + plane[2] * vertex.eye[2] + plane[3] * vertex.eye[3]);
    }
    return planes;
}

/**
 * Sutherland-Hodgman on a polygon or a line, one plane at a time.
 *
 * @param {ClipVertex[]} ring
 * @param {((vertex: ClipVertex) => number)[]} planes
 * @param {boolean} closed  a polygon, whose last vertex joins its first
 * @returns {ClipVertex[]}
 */
function clipRing(ring, planes, closed){
    let current = ring;
    for (const distance of planes)
    {
        if (current.length === 0)
        {
            break;
        }
        /** @type {ClipVertex[]} */
        const next = [];
        const edges = closed ? current.length : current.length - 1;
        for (let i = 0; i < edges; i++)
        {
            const a = current[i];
            const b = current[(i + 1) % current.length];
            const da = distance(a);
            const db = distance(b);
            if (da >= 0)
            {
                next.push(a);
            }
            if ((da >= 0) !== (db >= 0))
            {
                next.push(lerpVertex(a, b, da / (da - db)));
            }
            // A polygon's last vertex is the start of the closing edge and is
            // pushed there; a line's last vertex has no edge of its own.
            if (!closed && i === edges - 1 && db >= 0)
            {
                next.push(b);
            }
        }
        current = next;
    }
    return current;
}

/**
 * Stage three: window coordinates.
 *
 * @param {Scene} scene
 * @param {ClipVertex} vertex
 * @returns {import('./raster.js').RasterVertex | null}
 */
function toWindow(scene, vertex){
    const w = vertex.clip[3];
    if (w <= 0)
    {
        return null;
    }
    const [vx, vy, vw, vh] = scene.viewport;
    const [near, far] = scene.depthRange;
    const ndcZ = vertex.clip[2] / w;
    return {
        x: (vertex.clip[0] / w * 0.5 + 0.5) * vw + vx,
        y: scene.framebuffer.height - ((vertex.clip[1] / w * 0.5 + 0.5) * vh + vy),
        z: (far + near) / 2 + (far - near) / 2 * ndcZ,
        w: 1 / w,
        colour: vertex.colour.map(toByte),
        attributes: vertex.attributes,
    };
}

/**
 * The polygons a mode makes of `count` vertices, as index rings, each with
 * the index of its provoking vertex.
 *
 * @param {number} mode
 * @param {number} count
 * @returns {{ ring: number[], provoking: number }[]}
 */
export function polygonsOf(mode, count){
    /** @type {{ ring: number[], provoking: number }[]} */
    const polygons = [];
    if (mode === GL.TRIANGLES)
    {
        for (let i = 0; i + 2 < count; i += 3)
        {
            polygons.push({ ring: [i, i + 1, i + 2], provoking: i + 2 });
        }
    }
    else if (mode === GL.TRIANGLE_STRIP)
    {
        for (let i = 0; i + 2 < count; i++)
        {
            // Every second triangle in a strip is wound the other way round,
            // and two of its indices are swapped to put it back -- otherwise
            // a strip alternates facing and culling eats half of it.
            polygons.push({
                ring: i % 2 === 0 ? [i, i + 1, i + 2] : [i + 1, i, i + 2],
                provoking: i + 2,
            });
        }
    }
    else if (mode === GL.TRIANGLE_FAN)
    {
        for (let i = 1; i + 1 < count; i++)
        {
            polygons.push({ ring: [0, i, i + 1], provoking: i + 1 });
        }
    }
    else if (mode === GL.POLYGON)
    {
        if (count >= 3)
        {
            polygons.push({ ring: Array.from({ length: count }, (unused, i)=>i), provoking: 0 });
        }
    }
    else if (mode === GL.QUADS)
    {
        for (let i = 0; i + 3 < count; i += 4)
        {
            polygons.push({ ring: [i, i + 1, i + 2, i + 3], provoking: i + 3 });
        }
    }
    else if (mode === GL.QUAD_STRIP)
    {
        for (let i = 0; i + 3 < count; i += 2)
        {
            polygons.push({ ring: [i, i + 1, i + 3, i + 2], provoking: i + 3 });
        }
    }
    return polygons;
}

/**
 * The line segments a line mode makes of `count` vertices.
 *
 * @param {number} mode
 * @param {number} count
 * @returns {{ from: number, to: number, provoking: number }[]}
 */
export function linesOf(mode, count){
    /** @type {{ from: number, to: number, provoking: number }[]} */
    const lines = [];
    if (mode === GL.LINES)
    {
        for (let i = 0; i + 1 < count; i += 2)
        {
            lines.push({ from: i, to: i + 1, provoking: i + 1 });
        }
    }
    else if (mode === GL.LINE_STRIP || mode === GL.LINE_LOOP)
    {
        for (let i = 0; i + 1 < count; i++)
        {
            lines.push({ from: i, to: i + 1, provoking: i + 1 });
        }
        if (mode === GL.LINE_LOOP && count >= 2)
        {
            lines.push({ from: count - 1, to: 0, provoking: 0 });
        }
    }
    return lines;
}

/**
 * Twice the signed area of a ring in window coordinates. Negative is
 * counter-clockwise as GL sees it: y grows the other way here, and a flip of
 * one axis reverses every winding.
 *
 * @param {readonly import('./raster.js').RasterVertex[]} ring
 * @returns {number}
 */
function signedArea(ring){
    let area = 0;
    for (let i = 0; i < ring.length; i++)
    {
        const p = ring[i];
        const q = ring[(i + 1) % ring.length];
        area += p.x * q.y - q.x * p.y;
    }
    return area;
}

/**
 * Stage five, per fragment: the texture units, the colour sum, fog and the
 * alpha test. Returns the colour to write, in 0..255, or null when the alpha
 * test dropped the fragment.
 *
 * @param {Scene} scene
 * @param {import('./raster.js').Fragment} fragment
 * @returns {number[] | null}
 */
function shade(scene, fragment){
    const primary = fragment.colour.map(value=>value / 255);
    let colour = primary;
    const attributes = fragment.attributes;
    scene.units.forEach((unit, position)=>{
        const at = TEXTURE + position * 4;
        const q = attributes[at + 3] === 0 ? 1 : attributes[at + 3];
        /** @type {number[]} */
        let texel;
        if (unit.cube)
        {
            const face = cubeFaceOf(
                attributes[at] / q, attributes[at + 1] / q, attributes[at + 2] / q);
            texel = sample2D(unit.images[face.face], unit.parameters, face.s, face.t);
        }
        else
        {
            texel = sample2D(
                unit.images[0], unit.parameters, attributes[at] / q, attributes[at + 1] / q);
        }
        colour = applyTextureEnvironment(
            unit.env, unit.baseFormat, colour, texel.map(value=>value / 255), primary);
    });
    if (scene.colourSum)
    {
        colour = [
            Math.min(1, colour[0] + attributes[SECONDARY]),
            Math.min(1, colour[1] + attributes[SECONDARY + 1]),
            Math.min(1, colour[2] + attributes[SECONDARY + 2]),
            colour[3],
        ];
    }
    if (scene.fog)
    {
        const f = attributes[FOG];
        const fc = scene.fog.colour;
        colour = [
            f * colour[0] + (1 - f) * fc[0],
            f * colour[1] + (1 - f) * fc[1],
            f * colour[2] + (1 - f) * fc[2],
            colour[3],
        ];
    }
    const out = colour.map(value=>value * 255);
    if (scene.alphaTest
        && !compare(scene.alphaTest.func, Math.round(out[3]), toByte(scene.alphaTest.reference)))
    {
        return null;
    }
    return out;
}

/**
 * Draws one primitive.
 *
 * @param {Scene} scene
 * @param {number} mode
 * @param {readonly PipelineVertex[]} vertices
 */
export function drawPrimitive(scene, mode, vertices){
    const processed = vertices.map(vertex=>processVertex(scene, vertex));
    const planes = clipDistances(scene);
    const target = scene.framebuffer;
    const emit = (/** @type {import('./raster.js').Fragment} */ fragment)=>{
        const colour = shade(scene, fragment);
        if (colour)
        {
            writeFragment(target, fragment.x, fragment.y, fragment.z, colour, scene.operations);
        }
    };
    const flatten = (
        /** @type {import('./raster.js').RasterVertex[]} */ points,
        /** @type {import('./raster.js').RasterVertex} */ provoking)=>(scene.flat
        ? points.map(point=>({
            ...point,
            colour: provoking.colour,
            attributes: [
                ...provoking.attributes?.slice(SECONDARY, SECONDARY + 4) ?? [0, 0, 0, 1],
                ...point.attributes?.slice(FOG) ?? [],
            ],
        }))
        : points);
    const pointSize = Math.max(1, Math.round(scene.pointSize));

    if (mode === GL.POINTS)
    {
        for (const vertex of processed)
        {
            if (planes.every(distance=>distance(vertex) >= 0))
            {
                const point = toWindow(scene, vertex);
                if (point)
                {
                    rasterPoint(target, point, pointSize, scene.scissor, emit);
                }
            }
        }
        return;
    }

    if (mode === GL.LINES || mode === GL.LINE_STRIP || mode === GL.LINE_LOOP)
    {
        for (const segment of linesOf(mode, processed.length))
        {
            const clipped = clipRing(
                [processed[segment.from], processed[segment.to]], planes, false);
            if (clipped.length < 2)
            {
                continue;
            }
            const from = toWindow(scene, clipped[0]);
            const to = toWindow(scene, clipped[1]);
            const provoking = toWindow(scene, processed[segment.provoking]);
            if (from && to && provoking)
            {
                const [a, b] = flatten([from, to], provoking);
                rasterLine(target, a, b, scene.scissor, emit);
            }
        }
        return;
    }

    for (const polygon of polygonsOf(mode, processed.length))
    {
        const clipped = clipRing(polygon.ring.map(index=>processed[index]), planes, true);
        if (clipped.length < 3)
        {
            continue;
        }
        const ring = clipped.map(vertex=>toWindow(scene, vertex));
        if (ring.some(vertex=>vertex === null))
        {
            continue;
        }
        const windowRing = /** @type {import('./raster.js').RasterVertex[]} */ (ring);
        const area = signedArea(windowRing);
        if (area === 0)
        {
            continue;
        }
        const isFront = scene.frontIsCcw === (area < 0);
        if (scene.cull)
        {
            const mode_ = scene.cull.mode;
            if (mode_ === GL.FRONT_AND_BACK || (mode_ === GL.FRONT) === isFront)
            {
                continue;
            }
        }
        const provokingVertex = toWindow(scene, processed[polygon.provoking]);
        const shaded = flatten(windowRing, provokingVertex ?? windowRing[0]);
        const polygonMode = scene.polygonMode[isFront ? 0 : 1];
        if (polygonMode === GL.POINT)
        {
            for (const vertex of shaded)
            {
                rasterPoint(target, vertex, pointSize, scene.scissor, emit);
            }
        }
        else if (polygonMode === GL.LINE)
        {
            for (let i = 0; i < shaded.length; i++)
            {
                rasterLine(target, shaded[i], shaded[(i + 1) % shaded.length], scene.scissor, emit);
            }
        }
        else
        {
            for (let i = 1; i + 1 < shaded.length; i++)
            {
                rasterTriangle(target, [shaded[0], shaded[i], shaded[i + 1]], scene.scissor, emit);
            }
        }
    }
}
