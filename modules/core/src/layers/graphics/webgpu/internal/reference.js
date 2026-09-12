/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The fixed-function formula, evaluated on the processor.
 *
 * A picture off a real device is not reproducible: drivers differ in their
 * rasterisation rules, their filtering and their floating-point rounding, so
 * the same draw gives different bytes on different machines and a stored image
 * cannot be compared against it. That is a fact about graphics hardware, not a
 * gap to be closed.
 *
 * So the formula is written here as well, in integer arithmetic that gives the
 * same bytes everywhere, and the byte-exact tests compare against this. What
 * that proves is the formula: the channel order, the blend, the alpha test, the
 * sampling. What it does not prove is that the generated shader computes the
 * same thing -- only a device can show that, and a device cannot be held to a
 * stored image. The two are checked differently on purpose, and the seam
 * between them is the one place this arrangement is blind.
 *
 * Pixels are the engine's own: 32-bit BGRX, the little-endian dword
 * `0x00RRGGBB`, so the byte at the lowest address is blue. `graphics/gdi` says
 * the same thing and this agrees with it deliberately -- two conventions in one
 * engine is a bug generator.
 *
 * Lighting is the exception to the integer arithmetic, and deliberately so: it
 * runs per vertex rather than per fragment, and Direct3D computes it in floats
 * and clamps once at the end. Quantising it to bytes here would make this
 * disagree with the shader by a level in places and would prove the wrong
 * thing.
 */

import { D3DLIGHT, D3DTA, D3DTOP, argumentsRead } from './fixedfunction.js';

/** Bytes per pixel, everywhere in this engine. */
const BPP = 4;

/**
 * @typedef {Object} ReferenceSurface
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} bytes   BGRX, `width * 4` bytes to a row.
 */

/**
 * @param {number} width
 * @param {number} height
 * @returns {ReferenceSurface}
 */
export function createReferenceSurface(width, height){
    return { width, height, bytes: new Uint8Array(width * height * BPP) };
}

/**
 * Fills every pixel, which is what a clear does.
 *
 * @param {ReferenceSurface} surface
 * @param {{ r: number, g: number, b: number, a?: number }} colour  0..255 each
 */
export function clear(surface, colour){
    const alpha = colour.a === undefined ? 255 : colour.a;
    for (let at = 0; at < surface.bytes.length; at += BPP)
    {
        surface.bytes[at] = colour.b;
        surface.bytes[at + 1] = colour.g;
        surface.bytes[at + 2] = colour.r;
        surface.bytes[at + 3] = alpha;
    }
}

/**
 * Source over destination, with straight (non-premultiplied) alpha.
 *
 * Which of the two conventions this is matters and is stated rather than left
 * to be inferred: straight and premultiplied agree exactly at alpha 0 and alpha
 * 255 and disagree at every value between, so a test that only checks the ends
 * cannot tell them apart.
 *
 * The rounding is `+ 127` before the divide, not truncation. Truncating loses
 * a level on almost every blend, which is invisible in one composite and
 * accumulates visibly over a chain of them.
 *
 * @param {number} source       0..255
 * @param {number} destination  0..255
 * @param {number} alpha        0..255
 * @returns {number}
 */
export function blendChannel(source, destination, alpha){
    return (source * alpha + destination * (255 - alpha) + 127) / 255 | 0;
}

/**
 * @param {ReferenceSurface} surface
 * @param {number} x @param {number} y
 * @param {{ r: number, g: number, b: number, a: number }} colour
 */
export function blendPixel(surface, x, y, colour){
    const at = (y * surface.width + x) * BPP;
    surface.bytes[at] = blendChannel(colour.b, surface.bytes[at], colour.a);
    surface.bytes[at + 1] = blendChannel(colour.g, surface.bytes[at + 1], colour.a);
    surface.bytes[at + 2] = blendChannel(colour.r, surface.bytes[at + 2], colour.a);
    // The destination keeps its own alpha: this surface is what gets presented,
    // and a target that accumulated source alpha would make a later composite
    // of it progressively more transparent.
}

/**
 * Nearest-neighbour sample, with the half-pixel offset written out.
 *
 * A sample takes the texel whose centre is nearest, so the coordinate is scaled
 * and then floored -- not rounded. Rounding shifts the whole image half a texel,
 * which looks like a plausible picture and is wrong, and is the reason a
 * magnified sample is tested as well as a one-to-one one.
 *
 * V is not flipped here. Direct3D's texture origin is the top-left, the same as
 * this surface's, so a flip would be an error rather than a convention.
 *
 * @param {ReferenceSurface} texture
 * @param {number} u @param {number} v  0..1
 * @returns {{ r: number, g: number, b: number, a: number }}
 */
export function sampleNearest(texture, u, v){
    const x = Math.min(texture.width - 1, Math.max(0, Math.floor(u * texture.width)));
    const y = Math.min(texture.height - 1, Math.max(0, Math.floor(v * texture.height)));
    const at = (y * texture.width + x) * BPP;
    return {
        b: texture.bytes[at],
        g: texture.bytes[at + 1],
        r: texture.bytes[at + 2],
        a: texture.bytes[at + 3],
    };
}

/**
 * One stage argument, resolved.
 *
 * @param {number} arg @param {any} sources
 * @returns {{r:number,g:number,b:number,a:number}}
 */
function argumentValue(arg, sources){
    const base = {
        [D3DTA.DIFFUSE]: sources.diffuse,
        [D3DTA.CURRENT]: sources.current,
        [D3DTA.TEXTURE]: sources.texture,
        [D3DTA.TFACTOR]: sources.textureFactor,
        [D3DTA.SPECULAR]: sources.specular,
    }[arg & D3DTA.SELECTMASK];

    if (base === undefined)
    {
        throw new Error(`Unsupported texture argument 0x${arg.toString(16)}`);
    }
    const replicated = (arg & D3DTA.ALPHAREPLICATE) !== 0
        ? { r: base.a, g: base.a, b: base.a, a: base.a }
        : base;
    if ((arg & D3DTA.COMPLEMENT) === 0)
    {
        return replicated;
    }
    return {
        r: 255 - replicated.r,
        g: 255 - replicated.g,
        b: 255 - replicated.b,
        a: 255 - replicated.a,
    };
}

/** @param {number} value */
const clamp8 = value=>(value < 0 ? 0 : value > 255 ? 255 : value | 0);

/**
 * One channel under one operation, in 0..255.
 *
 * `a` and `b` are the operation's own arguments in the order it reads them, not
 * the two slots: an operation that reads one slot reads it as `a` whichever
 * slot it was, so that the other is never resolved at all.
 *
 * @param {number} op @param {number} a @param {number} b @param {number} current
 * @returns {number}
 */
function applyOp(op, a, b, current){
    switch (op)
    {
        case D3DTOP.DISABLE:
            return current;
        case D3DTOP.SELECTARG1:
        case D3DTOP.SELECTARG2:
            return a;
        case D3DTOP.MODULATE:
            return clamp8((a * b + 127) / 255);
        case D3DTOP.MODULATE2X:
            return clamp8((a * b + 127) / 255 * 2);
        case D3DTOP.MODULATE4X:
            return clamp8((a * b + 127) / 255 * 4);
        case D3DTOP.ADD:
            return clamp8(a + b);
        case D3DTOP.ADDSIGNED:
            return clamp8(a + b - 128);
        case D3DTOP.SUBTRACT:
            return clamp8(a - b);
        default:
            throw new Error(`Unsupported texture operation ${op}`);
    }
}

/**
 * Runs the stage cascade for one fragment.
 *
 * An empty stage list leaves the diffuse colour untouched, which is what the
 * generated shader does too: a stage that is off is absent, not a neutral one,
 * because "neutral" is only neutral for some operations.
 *
 * @param {import('./pipeline.js').StageKey[]} stages
 * @param {any} sources
 * @returns {{ r: number, g: number, b: number, a: number }}
 */
export function runStages(stages, sources){
    let current = sources.diffuse;
    for (const stage of stages)
    {
        const context = { ...sources, current };
        // Only the slots the operation reads are resolved: an unread one is
        // allowed to hold a stale value this engine cannot spell, and the
        // shader never builds it either.
        const resolve = (/** @type {number[]} */ read)=>
            [0, 1].map(at=>at < read.length
                ? argumentValue(read[at], context)
                : { r: 0, g: 0, b: 0, a: 0 });
        const [a1, a2] = resolve(argumentsRead(stage.colorOp, stage.colorArg1, stage.colorArg2));
        const [b1, b2] = resolve(argumentsRead(stage.alphaOp, stage.alphaArg1, stage.alphaArg2));
        current = {
            r: applyOp(stage.colorOp, a1.r, a2.r, current.r),
            g: applyOp(stage.colorOp, a1.g, a2.g, current.g),
            b: applyOp(stage.colorOp, a1.b, a2.b, current.b),
            a: applyOp(stage.alphaOp, b1.a, b2.a, current.a),
        };
    }
    return current;
}

/**
 * Whether a fragment survives the alpha test.
 *
 * @param {number} func  D3DCMP
 * @param {number} alpha @param {number} reference
 * @returns {boolean}
 */
export function alphaPasses(func, alpha, reference){
    switch (func)
    {
        case 1: return false;
        case 2: return alpha < reference;
        case 3: return alpha === reference;
        case 4: return alpha <= reference;
        case 5: return alpha > reference;
        case 6: return alpha !== reference;
        case 7: return alpha >= reference;
        case 8: return true;
        default: throw new Error(`Unsupported alpha comparison ${func}`);
    }
}

/**
 * Fills an axis-aligned rectangle through the whole fragment path: cascade,
 * alpha test, blend. Enough to exercise the formula without a rasteriser --
 * a triangle would add edge rules that say nothing about the formula.
 *
 * The rectangle is half-open, `[x0, x1) x [y0, y1)`, which is the convention
 * `graphics/gdi` already uses; two conventions in one engine is a bug
 * generator.
 *
 * A texture transform, when given, is the six planar elements of the stage's
 * matrix as `d3d8/render.js` packs them -- (m11, m21, m31) then (m12, m22, m32)
 * -- applied to (u, v, 1) before the sample, which is what Direct3D does with a
 * two-coordinate set.
 *
 * @param {ReferenceSurface} target
 * @param {{ x0: number, y0: number, x1: number, y1: number }} rect
 * @param {any} options
 */
export function fillRect(target, rect, options){
    const stages = options.stages === undefined ? [] : options.stages;
    const planar = options.textureTransform === undefined
        ? [1, 0, 0, 0, 1, 0]
        : options.textureTransform;
    /** @param {number} u @param {number} v */
    const sampleTexture = (u, v)=>sampleNearest(options.texture,
        planar[0] * u + planar[1] * v + planar[2],
        planar[3] * u + planar[4] * v + planar[5]);
    for (let y = rect.y0; y < rect.y1; y++)
    {
        for (let x = rect.x0; x < rect.x1; x++)
        {
            const sources = {
                diffuse: options.diffuse,
                specular: options.specular === undefined
                    ? { r: 0, g: 0, b: 0, a: 0 }
                    : options.specular,
                textureFactor: options.textureFactor === undefined
                    ? { r: 255, g: 255, b: 255, a: 255 }
                    : options.textureFactor,
                texture: options.texture === undefined
                    ? { r: 255, g: 255, b: 255, a: 255 }
                    : sampleTexture(
                        (x - rect.x0 + 0.5) / (rect.x1 - rect.x0),
                        (y - rect.y0 + 0.5) / (rect.y1 - rect.y0)),
            };
            const colour = runStages(stages, sources);
            if (options.alphaTest
                && !alphaPasses(options.alphaFunc, colour.a, options.alphaRef))
            {
                continue;
            }
            if (options.blend === false)
            {
                const at = (y * target.width + x) * BPP;
                target.bytes[at] = colour.b;
                target.bytes[at + 1] = colour.g;
                target.bytes[at + 2] = colour.r;
                target.bytes[at + 3] = colour.a;
                continue;
            }
            blendPixel(target, x, y, colour);
        }
    }
}

/** @param {ReferenceSurface} surface @returns {string} */
export const toBase64 = surface=>Buffer.from(surface.bytes).toString('base64');

// --- the lighting equation, in the floats it is actually computed in ---

/**
 * @typedef {{ x: number, y: number, z: number }} Vector
 * @typedef {{ r: number, g: number, b: number, a: number }} Colour
 */

/** @param {Vector} a @param {Vector} b @returns {number} */
const dot = (a, b)=>a.x * b.x + a.y * b.y + a.z * b.z;

/** @param {Vector} a @param {Vector} b @returns {Vector} */
const minus = (a, b)=>({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/** @param {Vector} v @returns {number} */
const length = v=>Math.sqrt(dot(v, v));

/**
 * Divided by its own length, or by the guard when that is zero -- which turns
 * a degenerate direction into no contribution instead of a not-a-number, the
 * same way the generated shader does.
 *
 * @param {Vector} v @returns {Vector}
 */
const unit = v=>{
    const scale = Math.max(length(v), 1e-8);
    return { x: v.x / scale, y: v.y / scale, z: v.z / scale };
};

/**
 * How much of a light reaches a point, and from which direction.
 *
 * @param {any} light  a D3DLIGHT8
 * @param {Vector} position  world space
 * @returns {{ toLight: Vector, scale: number }}
 */
function illumination(light, position){
    if (light.Type === D3DLIGHT.DIRECTIONAL)
    {
        // The direction a light travels; the equation wants the way back to it.
        const towards = unit(light.Direction);
        return { toLight: { x: -towards.x, y: -towards.y, z: -towards.z }, scale: 1 };
    }
    const offset = minus(light.Position, position);
    const distance = length(offset);
    const toLight = unit(offset);
    let scale = 0;
    if (distance <= light.Range)
    {
        const denominator = light.Attenuation0 + light.Attenuation1 * distance
            + light.Attenuation2 * distance * distance;
        scale = denominator <= 0 ? 1 : 1 / denominator;
    }
    if (light.Type !== D3DLIGHT.SPOT)
    {
        return { toLight, scale };
    }
    const direction = unit(light.Direction);
    const rho = -dot(direction, toLight);
    const inner = Math.cos(light.Theta / 2);
    const outer = Math.cos(light.Phi / 2);
    const cone = rho > inner
        ? 1
        : (rho <= outer ? 0 : Math.pow((rho - outer) / (inner - outer), light.Falloff));
    return { toLight, scale: scale * cone };
}

/** @param {number} value */
const clamp1 = value=>(value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * @typedef {Object} LitVertex
 * @property {Vector} position    World space, which is where lighting happens.
 * @property {Vector} normal      World space; normalised here rather than assumed.
 * @property {Vector} eye         The camera, in world space.
 * @property {any[]} lights       D3DLIGHT8s, every one of them enabled.
 * @property {{ diffuse: Colour, ambient: Colour, specular: Colour, emissive: Colour }} sources
 *     Each term's colour, already resolved from the material or the vertex.
 * @property {Colour} sceneAmbient  D3DRS_AMBIENT.
 * @property {number} power         The material's specular power.
 * @property {boolean} specular     D3DRS_SPECULARENABLE.
 */

/**
 * The Direct3D lighting equation, for one vertex.
 *
 * This is the second writing of the formula the generated shader carries, and
 * the seam between the two is the one place this arrangement is blind -- see
 * the header. What it is here for is that the numbers are checkable: a light,
 * a material and a normal give one answer, and it can be worked out by hand.
 *
 * @param {LitVertex} vertex
 * @returns {{ diffuse: Colour, specular: Colour }}
 */
export function lightVertex(vertex){
    const normal = unit(vertex.normal);
    const toEye = unit(minus(vertex.eye, vertex.position));
    const ambient = { r: 0, g: 0, b: 0 };
    const diffuse = { r: 0, g: 0, b: 0 };
    const specular = { r: 0, g: 0, b: 0 };

    for (const light of vertex.lights)
    {
        const { toLight, scale } = illumination(light, vertex.position);
        const lambert = Math.max(dot(normal, toLight), 0) * scale;
        let highlight = 0;
        if (vertex.specular)
        {
            const halfway = unit({
                x: toLight.x + toEye.x, y: toLight.y + toEye.y, z: toLight.z + toEye.z,
            });
            highlight = Math.pow(Math.max(dot(normal, halfway), 0), vertex.power) * scale;
        }
        for (const channel of /** @type {const} */ (['r', 'g', 'b']))
        {
            ambient[channel] += light.Ambient[channel] * scale;
            diffuse[channel] += light.Diffuse[channel] * lambert;
            specular[channel] += light.Specular[channel] * highlight;
        }
    }

    const sources = vertex.sources;
    /** @param {'r'|'g'|'b'} channel */
    const lit = channel=>clamp1(sources.emissive[channel]
        + sources.ambient[channel] * (vertex.sceneAmbient[channel] + ambient[channel])
        + sources.diffuse[channel] * diffuse[channel]);
    /** @param {'r'|'g'|'b'} channel */
    const highlightOf = channel=>clamp1(sources.specular[channel] * specular[channel]);

    return {
        // The alpha is the diffuse source's, untouched: the equation is over
        // the three colour channels only.
        diffuse: { r: lit('r'), g: lit('g'), b: lit('b'), a: sources.diffuse.a },
        specular: {
            r: highlightOf('r'), g: highlightOf('g'), b: highlightOf('b'), a: 0,
        },
    };
}
