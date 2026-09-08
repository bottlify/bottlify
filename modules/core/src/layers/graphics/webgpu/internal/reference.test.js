/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The byte-exact suite.
 *
 * Every assertion here is against pixels this engine computed itself, so every
 * assertion is exact: the same input gives the same bytes on every run and
 * every machine. Where an expected image is stored it is base64 of the raw
 * BGRX buffer, beside the code that produced it, with a note saying what it is
 * evidence of.
 *
 * These do not touch a device. A real GPU cannot be held to a stored image --
 * drivers differ in rasterisation rules, filtering and floating-point rounding
 * -- so what a device does is checked by the commands it was issued, in
 * `backend.test.js`, and never by comparing a frame.
 *
 * Surfaces are 4x4 and 8x8. A larger one hides nothing and makes a failing
 * diff unreadable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    alphaPasses, blendChannel, clear, createReferenceSurface, fillRect,
    lightVertex, runStages, sampleNearest, toBase64,
} from './reference.js';
import { D3DLIGHT, D3DTA, D3DTOP } from './fixedfunction.js';

/**
 * A pixel as the four bytes at its offset, lowest address first.
 *
 * @param {any} surface @param {number} x @param {number} y @returns {number[]}
 */
const pixelAt = (surface, x, y)=>
    [...surface.bytes.subarray((y * surface.width + x) * 4, (y * surface.width + x) * 4 + 4)];

/** @param {number} r @param {number} g @param {number} b @param {number} [a] */
const solid = (r, g, b, a = 255)=>({ r, g, b, a });

test('1. a solid fill is that colour in every pixel, blue byte first', ()=>{
    // The single most common defect in this area is a channel swap, and it is
    // invisible in any test that uses grey. These channels are all different.
    const surface = createReferenceSurface(4, 4);
    clear(surface, solid(0x12, 0x34, 0x56));

    // BGRX: the byte at the lowest address is blue. A COLORREF is 0x00bbggrr
    // and a pixel is 0x00rrggbb, so the conversion between them is a red/blue
    // swap and not a copy -- graphics/gdi says the same and this agrees.
    assert.deepEqual(pixelAt(surface, 0, 0), [0x56, 0x34, 0x12, 0xff]);
    assert.deepEqual(pixelAt(surface, 3, 3), [0x56, 0x34, 0x12, 0xff]);

    // Evidence that every pixel was written and none was skipped: a fill that
    // missed the last row or column still passes a corner check.
    assert.equal(toBase64(surface),
        'VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/'
        + 'VjQS/1Y0Ev9WNBL/VjQS/w==');
});

test('2. alpha blending is straight, not premultiplied, and rounds', ()=>{
    // Straight and premultiplied agree exactly at 0 and 255 and disagree at
    // every value between, so the name of this test is load-bearing: it says
    // which convention the engine uses. Straight takes the source at full
    // strength and scales it here; premultiplied would take it as already
    // scaled, and 200 at half alpha over 40 would come out near 60 rather than
    // near 120.
    assert.equal(blendChannel(200, 40, 128), 120);

    // Rounding, not truncation. Most values cannot tell the two apart -- the
    // pair above gives 120 either way -- so the case has to be chosen: 11 at
    // alpha 250 over 0 is 11 rounded and 10 truncated. Truncating loses a level
    // on many blends, invisible once and visible over a chain of them.
    assert.equal(blendChannel(11, 0, 250), 11, 'rounds rather than truncating');

    const surface = createReferenceSurface(4, 4);
    clear(surface, solid(40, 60, 80));
    fillRect(surface, { x0: 0, y0: 0, x1: 4, y1: 4 },
        { diffuse: solid(200, 100, 0, 128) });
    assert.deepEqual(pixelAt(surface, 1, 1), [40, 80, 120, 255],
        'blue 0 over 80, green 100 over 60, red 200 over 40 — each channel separately');
});

test('2b. alpha 0 leaves the destination byte for byte, 255 replaces it', ()=>{
    // The two ends, where the conventions agree and a wrong one still shows.
    const surface = createReferenceSurface(4, 4);
    clear(surface, solid(0x11, 0x22, 0x33));
    const before = toBase64(surface);

    fillRect(surface, { x0: 0, y0: 0, x1: 4, y1: 4 }, { diffuse: solid(0xff, 0xee, 0xdd, 0) });
    assert.equal(toBase64(surface), before, 'alpha 0 touched nothing');

    fillRect(surface, { x0: 0, y0: 0, x1: 4, y1: 4 }, { diffuse: solid(0xff, 0xee, 0xdd, 255) });
    assert.deepEqual(pixelAt(surface, 2, 2), [0xdd, 0xee, 0xff, 0xff],
        'alpha 255 replaced it exactly, with no rounding drift');
});

test('3. colour precision survives a round trip, all 256 levels', ()=>{
    // Catches a channel truncated to five bits, an sRGB conversion applied
    // where none was asked for, and a premultiply done twice: each of those
    // changes some level, and stepping every one leaves nowhere to hide.
    const surface = createReferenceSurface(16, 16);
    for (let value = 0; value < 256; value++)
    {
        const x = value % 16;
        const y = (value / 16) | 0;
        fillRect(surface, { x0: x, y0: y, x1: x + 1, y1: y + 1 },
            { diffuse: solid(value, 255 - value, value ^ 0x55), blend: false });
    }

    for (let value = 0; value < 256; value++)
    {
        assert.deepEqual(
            pixelAt(surface, value % 16, (value / 16) | 0),
            [value ^ 0x55, 255 - value, value, 255],
            `level ${value} did not survive`,
        );
    }
});

test('4. a texture drawn one-to-one reproduces its texels exactly', ()=>{
    // Nearest sampling at matching size must be an identity. This is what
    // catches a half-pixel sample offset and a flipped V coordinate, both of
    // which produce a plausible picture.
    const texture = createReferenceSurface(2, 2);
    const corners = [solid(255, 0, 0), solid(0, 255, 0), solid(0, 0, 255), solid(255, 255, 0)];
    corners.forEach((colour, index)=>{
        fillRect(texture, { x0: index % 2, y0: (index / 2) | 0,
            x1: index % 2 + 1, y1: ((index / 2) | 0) + 1 },
        { diffuse: colour, blend: false });
    });

    const target = createReferenceSurface(2, 2);
    fillRect(target, { x0: 0, y0: 0, x1: 2, y1: 2 }, {
        diffuse: solid(255, 255, 255),
        texture,
        blend: false,
        stages: [{
            colorOp: D3DTOP.SELECTARG1, colorArg1: D3DTA.TEXTURE, colorArg2: D3DTA.DIFFUSE,
            alphaOp: D3DTOP.SELECTARG1, alphaArg1: D3DTA.TEXTURE, alphaArg2: D3DTA.DIFFUSE,
            texCoordIndex: 0,
        }],
    });

    // The top-left texel must land top-left: V is not flipped, because
    // Direct3D's texture origin and this surface's are both the top-left.
    assert.deepEqual(pixelAt(target, 0, 0), [0, 0, 255, 255], 'red stayed at the top left');
    assert.deepEqual(pixelAt(target, 1, 1), [0, 255, 255, 255],
        'yellow stayed at the bottom right');
    // All four texels, in place: evidence that nothing was transposed. A
    // transposed sample keeps both diagonal corners and swaps the other two,
    // so the corner checks above pass on their own.
    assert.equal(toBase64(target), 'AAD//wD/AP//AAD/AP///w==');
});

test('4b. a magnified texture repeats each texel, with no half-pixel drift', ()=>{
    // The same texture at twice the size pins the filter down: a rounding
    // sample instead of a flooring one shifts the whole image half a texel and
    // puts the boundary in the wrong place.
    const texture = createReferenceSurface(2, 1);
    fillRect(texture, { x0: 0, y0: 0, x1: 1, y1: 1 }, { diffuse: solid(255, 0, 0), blend: false });
    fillRect(texture, { x0: 1, y0: 0, x1: 2, y1: 1 }, { diffuse: solid(0, 0, 255), blend: false });

    const target = createReferenceSurface(4, 1);
    fillRect(target, { x0: 0, y0: 0, x1: 4, y1: 1 }, {
        diffuse: solid(255, 255, 255),
        texture,
        blend: false,
        stages: [{
            colorOp: D3DTOP.SELECTARG1, colorArg1: D3DTA.TEXTURE, colorArg2: D3DTA.DIFFUSE,
            alphaOp: D3DTOP.SELECTARG1, alphaArg1: D3DTA.TEXTURE, alphaArg2: D3DTA.DIFFUSE,
            texCoordIndex: 0,
        }],
    });

    assert.deepEqual(pixelAt(target, 0, 0), [0, 0, 255, 255]);
    assert.deepEqual(pixelAt(target, 1, 0), [0, 0, 255, 255], 'the boundary is after pixel 1');
    assert.deepEqual(pixelAt(target, 2, 0), [255, 0, 0, 255]);
    assert.deepEqual(pixelAt(target, 3, 0), [255, 0, 0, 255]);
});

test('5. the stage cascade modulates, and a second stage sees the first', ()=>{
    // What §14.15 is about, checked on values rather than on a key: the second
    // stage reads CURRENT, so a cascade that restarts from the diffuse at every
    // stage gives a different colour and no error.
    const half = solid(128, 128, 128);
    const result = runStages([
        {
            colorOp: D3DTOP.MODULATE, colorArg1: D3DTA.TEXTURE, colorArg2: D3DTA.DIFFUSE,
            alphaOp: D3DTOP.SELECTARG1, alphaArg1: D3DTA.TEXTURE, alphaArg2: D3DTA.DIFFUSE,
            texCoordIndex: 0,
        },
        {
            colorOp: D3DTOP.MODULATE, colorArg1: D3DTA.CURRENT, colorArg2: D3DTA.TFACTOR,
            alphaOp: D3DTOP.SELECTARG1, alphaArg1: D3DTA.CURRENT, alphaArg2: D3DTA.CURRENT,
            texCoordIndex: 0,
        },
    ], {
        diffuse: solid(255, 255, 255),
        specular: solid(0, 0, 0, 0),
        texture: half,
        textureFactor: half,
    });

    // 128*255/255 = 128, then 128*128/255 = 64 with rounding.
    assert.deepEqual([result.r, result.g, result.b], [64, 64, 64]);
});

test('5b. an argument modifier replicates alpha and inverts, in that order', ()=>{
    // The two modifiers compose, and the order is the API's: replicate, then
    // invert. Reversed, the inversion happens on the colour and is then thrown
    // away by the replicate, which is a plausible-looking wrong answer.
    const result = runStages([{
        colorOp: D3DTOP.SELECTARG1,
        colorArg1: D3DTA.TEXTURE | D3DTA.ALPHAREPLICATE | D3DTA.COMPLEMENT,
        colorArg2: D3DTA.DIFFUSE,
        alphaOp: D3DTOP.SELECTARG1, alphaArg1: D3DTA.TEXTURE, alphaArg2: D3DTA.DIFFUSE,
        texCoordIndex: 0,
    }], {
        diffuse: solid(255, 255, 255),
        specular: solid(0, 0, 0, 0),
        texture: solid(10, 20, 30, 200),
        textureFactor: solid(255, 255, 255),
    });

    assert.deepEqual([result.r, result.g, result.b], [55, 55, 55], '255 - 200, in every channel');
});

test('the alpha test discards rather than blending to nothing', ()=>{
    // A discarded fragment writes no depth; one blended to zero alpha still
    // does. That is the difference between an alpha-tested fence and a
    // fence-shaped hole in everything drawn after it.
    assert.equal(alphaPasses(5, 200, 128), true, 'greater');
    assert.equal(alphaPasses(5, 100, 128), false);
    assert.equal(alphaPasses(1, 255, 0), false, 'never, whatever the values');
    assert.equal(alphaPasses(8, 0, 255), true, 'always, likewise');

    const surface = createReferenceSurface(4, 4);
    clear(surface, solid(0x11, 0x22, 0x33));
    const before = toBase64(surface);
    fillRect(surface, { x0: 0, y0: 0, x1: 4, y1: 4 }, {
        diffuse: solid(255, 255, 255, 100),
        alphaTest: true,
        alphaFunc: 5,
        alphaRef: 128,
    });
    assert.equal(toBase64(surface), before, 'every fragment failed and nothing was written');
});

test('a sample outside the texture clamps rather than wrapping off the end', ()=>{
    const texture = createReferenceSurface(2, 2);
    clear(texture, solid(9, 9, 9));
    assert.deepEqual(sampleNearest(texture, -1, -1), { r: 9, g: 9, b: 9, a: 255 });
    assert.deepEqual(sampleNearest(texture, 2, 2), { r: 9, g: 9, b: 9, a: 255 });
});

// --- the lighting equation ---

/** @param {object} over @returns {any} a D3DLIGHT8 that contributes nothing on its own */
const light = (over = {})=>({
    Type: D3DLIGHT.DIRECTIONAL,
    Diffuse: { r: 0, g: 0, b: 0, a: 0 },
    Specular: { r: 0, g: 0, b: 0, a: 0 },
    Ambient: { r: 0, g: 0, b: 0, a: 0 },
    Position: { x: 0, y: 0, z: 0 },
    Direction: { x: 0, y: 0, z: 1 },
    Range: 0,
    Falloff: 1,
    Attenuation0: 1,
    Attenuation1: 0,
    Attenuation2: 0,
    Theta: 0,
    Phi: 0,
    ...over,
});

const BLACK = { r: 0, g: 0, b: 0, a: 0 };
const WHITE = { r: 1, g: 1, b: 1, a: 1 };

/** @param {object} over @returns {any} */
const lit = (over = {})=>({
    position: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: -1 },
    eye: { x: 0, y: 0, z: -1 },
    lights: [],
    sources: { diffuse: BLACK, ambient: BLACK, specular: BLACK, emissive: BLACK },
    sceneAmbient: BLACK,
    power: 0,
    specular: false,
    ...over,
});

test('lighting: a directional light is the cosine of the angle to it, and nothing else', ()=>{
    // The one term that gives a lit scene its shape. A normal facing the light
    // gets all of it and one facing away gets none -- not a negative amount,
    // which would subtract light from the rest of the sum.
    const surface = { r: 0.5, g: 0.25, b: 0.125, a: 0.75 };
    const facing = lightVertex(lit({
        lights: [light({ Diffuse: WHITE })],
        sources: { diffuse: surface, ambient: BLACK, specular: BLACK, emissive: BLACK },
    }));
    assert.deepEqual(facing.diffuse, surface);

    const away = lightVertex(lit({
        normal: { x: 0, y: 0, z: 1 },
        lights: [light({ Diffuse: WHITE })],
        sources: { diffuse: surface, ambient: BLACK, specular: BLACK, emissive: BLACK },
    }));
    assert.deepEqual(away.diffuse, { r: 0, g: 0, b: 0, a: 0.75 },
        'and the alpha is the diffuse source\'s, whatever the light did');

    // A normal at forty-five degrees to the light gets one over root two of it.
    const tilted = lightVertex(lit({
        normal: { x: 1, y: 0, z: -1 },
        lights: [light({ Diffuse: WHITE })],
        sources: { diffuse: WHITE, ambient: BLACK, specular: BLACK, emissive: BLACK },
    }));
    assert.equal(tilted.diffuse.r, 1 / Math.sqrt(2));
});

test('lighting: ambient light reaches the vertex through the material, not around it', ()=>{
    // The scene's ambient and each light's own are both multiplied by the
    // material's ambient colour. Adding either directly is what makes an
    // unlit corner of a scene glow.
    const value = lightVertex(lit({
        lights: [light({ Ambient: { r: 0.125, g: 0.125, b: 0.125, a: 0 } })],
        sources: {
            diffuse: BLACK,
            ambient: { r: 0.5, g: 0, b: 0, a: 0 },
            specular: BLACK,
            emissive: { r: 0, g: 0, b: 0.25, a: 0 },
        },
        sceneAmbient: { r: 0.25, g: 0.25, b: 0.25, a: 0 },
    }));
    assert.equal(value.diffuse.r, 0.1875, '0.5 * (0.25 + 0.125)');
    assert.equal(value.diffuse.g, 0, 'the material has no green for the light to reach');
    assert.equal(value.diffuse.b, 0.25, 'emissive is added on its own, unlit');
});

test('lighting: the sum is clamped once, at the end', ()=>{
    const value = lightVertex(lit({
        lights: [light({ Diffuse: WHITE })],
        sources: {
            diffuse: { r: 1, g: 0, b: 0, a: 1 },
            ambient: BLACK,
            specular: BLACK,
            emissive: { r: 0.75, g: 0, b: 0, a: 0 },
        },
    }));
    assert.equal(value.diffuse.r, 1, 'and not 1.75');
});

test('lighting: a point light attenuates by distance and stops at its range', ()=>{
    /** @param {object} over */
    const at = over=>lightVertex(lit({
        normal: { x: 0, y: 0, z: 1 },
        lights: [light({
            Type: D3DLIGHT.POINT,
            Diffuse: WHITE,
            Position: { x: 0, y: 0, z: 10 },
            Range: 100,
            Attenuation0: 0,
            Attenuation1: 0.5,
            ...over,
        })],
        sources: { diffuse: WHITE, ambient: BLACK, specular: BLACK, emissive: BLACK },
    })).diffuse.r;

    // One over (0.5 * 10). The direction to the light is its position less the
    // vertex; the other way round lights the wrong side of everything.
    assert.equal(at({}), 0.2);
    assert.equal(at({ Range: 5 }), 0, 'past its range it contributes nothing at all');
    assert.equal(at({ Attenuation1: 0 }), 1,
        'every coefficient zero is no falloff, not a division by zero');
});

test('lighting: a spotlight is full inside its inner cone and dark outside its outer one', ()=>{
    /** @param {object} over @param {{ x: number, y: number, z: number }} where */
    const cone = (over, where)=>lightVertex(lit({
        position: where,
        // Facing the light, which is at the origin, so that the cosine of the
        // angle to it is one and the whole answer is the cone factor.
        normal: { x: -where.x, y: -where.y, z: -where.z },
        lights: [light({
            Type: D3DLIGHT.SPOT,
            Diffuse: WHITE,
            Position: { x: 0, y: 0, z: 0 },
            Direction: { x: 0, y: 0, z: 1 },
            Range: 100,
            Theta: Math.PI / 2,
            Phi: (2 * Math.PI) / 3,
            ...over,
        })],
        sources: { diffuse: WHITE, ambient: BLACK, specular: BLACK, emissive: BLACK },
    })).diffuse.r;

    // Straight down the axis, with the normal facing the light, so the whole
    // answer is the cone factor.
    assert.equal(cone({}, { x: 0, y: 0, z: 1 }), 1);
    // Ninety degrees off an axis whose outer half-angle is sixty is outside the
    // cone, and outside is nothing rather than a small remainder.
    assert.equal(cone({}, { x: 1, y: 0, z: 0 }), 0);
});

test('lighting: between the cones a spotlight falls off by its exponent', ()=>{
    // Forty-five degrees off the axis of a cone that is full to zero degrees
    // and dark past sixty, so the factor is (cos 45 - cos 60) / (1 - cos 60).
    /** @param {number} falloff */
    const between = falloff=>lightVertex(lit({
        position: { x: 1, y: 0, z: 1 },
        normal: { x: -1, y: 0, z: -1 },
        lights: [light({
            Type: D3DLIGHT.SPOT,
            Diffuse: WHITE,
            Position: { x: 0, y: 0, z: 0 },
            Direction: { x: 0, y: 0, z: 1 },
            Range: 100,
            Theta: 0,
            Phi: (2 * Math.PI) / 3,
            Falloff: falloff,
        })],
        sources: { diffuse: WHITE, ambient: BLACK, specular: BLACK, emissive: BLACK },
    })).diffuse.r;

    // (cos 45 - cos 60) / (1 - cos 60), which is root two minus one, to the
    // precision the cosines are computed at.
    const linear = between(1);
    assert.equal(linear, 0.4142135623730947);
    // That value squared: the falloff is an exponent, not a scale, which a
    // doubled or halved factor would also fit.
    assert.equal(between(2), 0.17157287525380968);
});

test('lighting: the specular term is a separate colour, and off unless it is enabled', ()=>{
    const head = {
        normal: { x: 0, y: 0, z: -1 },
        eye: { x: 0, y: 0, z: -5 },
        lights: [light({ Specular: { r: 1, g: 1, b: 0.5, a: 1 } })],
        sources: {
            diffuse: BLACK, ambient: BLACK, emissive: BLACK,
            specular: { r: 0.5, g: 0.25, b: 1, a: 1 },
        },
        power: 8,
    };
    // Light, eye and normal all on one axis: the half vector is the normal, so
    // the highlight is one whatever the power.
    const on = lightVertex(lit({ ...head, specular: true }));
    assert.deepEqual(on.specular, { r: 0.5, g: 0.25, b: 0.5, a: 0 });
    assert.deepEqual(on.diffuse, { r: 0, g: 0, b: 0, a: 0 },
        'and none of it is mixed into the diffuse colour');

    const off = lightVertex(lit(head));
    assert.deepEqual(off.specular, { r: 0, g: 0, b: 0, a: 0 });
});

test('lighting: the specular power is the exponent on the half-angle cosine', ()=>{
    /** @param {number} power */
    const highlight = power=>lightVertex(lit({
        // The eye is off the axis, so the half vector is not the normal and
        // the cosine is worth raising to a power.
        normal: { x: 0, y: 0, z: -1 },
        eye: { x: 1, y: 0, z: -1 },
        lights: [light({ Specular: WHITE })],
        sources: {
            diffuse: BLACK, ambient: BLACK, emissive: BLACK, specular: WHITE,
        },
        power,
        specular: true,
    })).specular.r;

    // The eye is forty-five degrees off the normal, so the half vector is
    // twenty-two and a half degrees off it and the cosine is cos 22.5.
    assert.equal(highlight(1), 0.9238795325112867);
    assert.equal(highlight(2), 0.8535533905932737, 'that value squared');
    assert.equal(highlight(0), 1, 'a power of zero is a highlight everywhere, as the formula says');
});
