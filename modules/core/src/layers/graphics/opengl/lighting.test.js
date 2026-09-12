/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createLight, createMaterial, lightVertex, normalMatrix, normalise } from './lighting.js';
import { multiply, rotation, scaling, translation } from './matrix.js';
import { inverseTransposeOf } from './context-textures.js';

const MODEL = { ambient: [0, 0, 0, 1], localViewer: false, separateSpecular: false };

/** @param {number[]} values @returns {number[]} */
const rounded = values=>values.map(value=>Math.round(value * 1000) / 1000 + 0);

test('the normal matrix is the inverse transpose, which only a non-uniform scale shows', ()=>{
    const rotated = rotation(90, 0, 0, 1);
    assert.deepEqual(rounded(normalMatrix(rotated)),
        rounded([rotated[0], rotated[1], rotated[2], rotated[4], rotated[5], rotated[6],
            rotated[8], rotated[9], rotated[10]]), 'a rotation is its own inverse transpose');

    // Scaling x by 2 scales a normal's x by a half: the surface tilts the
    // other way from the geometry.
    const scaled = scaling(2, 1, 1);
    const n = normalMatrix(scaled);
    assert.deepEqual(rounded([n[0], n[4], n[8]]), [0.5, 1, 1]);

    // Translation leaves normals alone; a singular matrix gives the identity
    // rather than NaN.
    assert.deepEqual(normalMatrix(translation(5, 6, 7)), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    assert.deepEqual(normalMatrix(scaling(0, 1, 1)), [1, 0, 0, 0, 1, 0, 0, 0, 1]);

    // The 4x4 form carries a plane the same way.
    const inverse = inverseTransposeOf(multiply(translation(1, 0, 0), scaling(2, 1, 1)));
    assert.deepEqual(rounded(inverse), rounded([
        0.5, 0, 0, -0.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]));
});

test('a directional light gives the diffuse term by the cosine and no specular past 90', ()=>{
    const light = createLight(0);
    const material = createMaterial();
    material.diffuse = [1, 1, 1, 1];
    material.ambient = [0, 0, 0, 1];
    material.specular = [1, 1, 1, 1];
    material.shininess = 10;

    const facing = lightVertex({ position: [0, 0, 0, 1], normal: [0, 0, 1], material,
        model: MODEL, lights: [light] });
    assert.deepEqual(rounded(facing.primary), [1, 1, 1, 1], 'diffuse and specular saturate');

    const tilted = lightVertex({ position: [0, 0, 0, 1], normal: normalise([1, 0, 1]), material,
        model: MODEL, lights: [light] });
    // cos 45 = 0.707 diffuse. The half vector between the light and the
    // infinite viewer is (0, 0, 1), so the specular is 0.707^10 = 0.031.
    assert.deepEqual(rounded(tilted.primary), [0.738, 0.738, 0.738, 1]);
    material.specular = [0, 0, 0, 1];
    const diffuseOnly = lightVertex({ position: [0, 0, 0, 1], normal: normalise([1, 0, 1]),
        material, model: MODEL, lights: [light] });
    assert.deepEqual(rounded(diffuseOnly.primary), [0.707, 0.707, 0.707, 1]);

    const away = lightVertex({ position: [0, 0, 0, 1], normal: [0, 0, -1], material,
        model: MODEL, lights: [light] });
    assert.deepEqual(away.primary, [0, 0, 0, 1]);
});

test('a positional light attenuates with distance and a spot light has a cone', ()=>{
    const light = createLight(0);
    light.position = [0, 0, 2, 1];
    light.quadraticAttenuation = 1;
    light.constantAttenuation = 0;
    const material = createMaterial();
    material.diffuse = [1, 1, 1, 1];
    material.ambient = [0, 0, 0, 1];
    const lit = lightVertex({ position: [0, 0, 0, 1], normal: [0, 0, 1], material, model: MODEL,
        lights: [light] });
    assert.deepEqual(rounded(lit.primary), [0.25, 0.25, 0.25, 1], 'one over distance squared');

    light.constantAttenuation = 1;
    light.quadraticAttenuation = 0;
    light.spotCutoff = 30;
    light.spotDirection = [0, 0, -1];
    const inside = lightVertex({ position: [0, 0, 0, 1], normal: [0, 0, 1], material,
        model: MODEL, lights: [light] });
    assert.deepEqual(rounded(inside.primary), [1, 1, 1, 1]);
    const outside = lightVertex({ position: [3, 0, 0, 1], normal: [0, 0, 1], material,
        model: MODEL, lights: [light] });
    assert.deepEqual(outside.primary, [0, 0, 0, 1], 'past the cutoff there is no light');
});

test('separate specular goes to the secondary colour and the model ambient adds', ()=>{
    const light = createLight(0);
    const material = createMaterial();
    material.specular = [1, 0, 0, 1];
    material.diffuse = [0, 0, 0, 1];
    material.ambient = [0, 0.5, 0, 1];
    const lit = lightVertex({ position: [0, 0, 0, 1], normal: [0, 0, 1], material,
        model: { ...MODEL, ambient: [1, 1, 1, 1], separateSpecular: true }, lights: [light] });
    assert.deepEqual(rounded(lit.primary), [0, 0.5, 0, 1]);
    assert.deepEqual(rounded(lit.secondary), [1, 0, 0, 1]);
    assert.equal(createLight(1).diffuse[0], 0, 'only light zero starts lit');
    assert.equal(GL.LIGHT7 - GL.LIGHT0, 7);
});
