/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ProcessVertices against Wine's ddraw7 test_process_vertices and
 * test_lighting: the positions each viewport, transform and blend gives, the
 * colours lighting gives, and what is copied through.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3DPV_DONOTCOPYDATA, D3DVOP, processVertices } from './process.js';
import { D3D_OK, DDERR_INVALIDPARAMS } from './constants.js';
import { D3DLIGHTTYPE, D3DMCS, D3DRS, D3DTS } from '../d3d8/constants.js';
import { FVF, decodeFvf } from '../webgpu/internal/vertexformat.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A flat buffer, and vertex buffers carved out of it. */
function space(){
    const ram = new Uint8Array(1 << 16);
    const view = new DataView(ram.buffer);
    let next = 0x100;
    const memory = {
        /** @param {number} at @param {number} length */
        readMemory: (at, length)=>ram.slice(at, at + length),
        /** @param {number} at @param {Uint8Array} bytes */
        writeMemory: (at, bytes)=>ram.set(bytes, at),
    };
    /** @param {number} fvf @param {number} numVertices */
    const buffer = (fvf, numVertices)=>{
        const stride = decodeFvf(fvf).stride;
        const base = next;
        next += stride * numVertices + 0xf & ~0xf;
        return { base, fvf, numVertices, stride };
    };
    /** @param {any} vb @param {number[][]} vertices  each as dwords and floats, in order */
    const fill = (vb, vertices)=>vertices.forEach((values, k)=>values.forEach((value, i)=>{
        const at = vb.base + k * vb.stride + i * 4;
        if (Number.isInteger(value) && value > 0xffff)
        {
            view.setUint32(at, value, true);
        }
        else
        {
            view.setFloat32(at, value, true);
        }
    }));
    /** @param {any} vb */
    const source = vb=>{
        const layout = decodeFvf(vb.fvf);
        return {
            fvf: vb.fvf,
            /** @param {string} name @param {number} k */
            addressOf: (name, k)=>{
                const attribute = layout.attributes.find(entry=>entry.name === name);
                return attribute ? vb.base + k * vb.stride + attribute.offset : null;
            },
        };
    };
    /** @param {number} at */
    const float = at=>view.getFloat32(at, true);
    /** @param {number} at */
    const dword = at=>view.getUint32(at, true);
    return { memory, buffer, fill, source, float, dword };
}

/**
 * @param {{ transforms?: Record<number, number[]>, viewport?: any,
 *   states?: Record<number, number>, lights?: any[], material?: any }} [spec]
 */
function device(spec = {}){
    /** @type {Record<number, number>} */
    const defaults = {
        [D3DRS.LIGHTING]: 1, [D3DRS.COLORVERTEX]: 1, [D3DRS.LOCALVIEWER]: 1,
        [D3DRS.DIFFUSEMATERIALSOURCE]: D3DMCS.COLOR1,
        [D3DRS.SPECULARMATERIALSOURCE]: D3DMCS.COLOR2,
    };
    const states = { ...defaults, ...spec.states };
    const white = { r: 1, g: 1, b: 1, a: 1 };
    const black = { r: 0, g: 0, b: 0, a: 0 };
    return {
        /** @param {number} type */
        transform: type=>spec.transforms?.[type] ?? IDENTITY,
        viewport: spec.viewport ?? { x: 64, y: 64, width: 128, height: 128,
            minDepth: 0, maxDepth: 1 },
        /** @param {number} state */
        renderState: state=>states[state] ?? 0,
        lights: spec.lights ?? [],
        material: spec.material
            ?? { Diffuse: white, Ambient: white, Specular: black, Emissive: black, Power: 0 },
    };
}

/** @param {number[]} actual @param {number[]} expected @param {string} what */
function near(actual, expected, what){
    actual.forEach((value, k)=>assert.ok(Math.abs(value - expected[k]) <= 1e-3 * Math.max(1,
        Math.abs(expected[k])), `${what}: ${actual} against ${expected}`));
}

const QUAD = [[0, 0, 0], [1, 1, 1], [-1, -1, 0.5], [0.5, -0.5, 0.25]];

test('transformed positions land in the viewport, depth in its range, rhw beside them', ()=>{
    const s = space();
    const src = s.buffer(FVF.XYZ, 4);
    s.fill(src, QUAD);
    const dest = s.buffer(FVF.XYZRHW, 4);
    /** @param {any} state @param {number[][]} expected @param {string} what */
    const check = (state, expected, what)=>{
        assert.equal(processVertices({ memory: s.memory, vertexOp: D3DVOP.TRANSFORM, dest,
            destIndex: 0, count: 4, source: s.source(src), state, flags: 0 }), D3D_OK);
        expected.forEach((vertex, k)=>near([0, 1, 2, 3].map(i=>s.float(dest.base + k * 16 + i * 4)),
            vertex, `${what}, vertex ${k}`));
    };
    check(device(), [[128, 128, 0, 1], [192, 64, 1, 1], [64, 192, 0.5, 1], [160, 160, 0.25, 1]],
        'identity');
    const degenerate = { x: 64, y: 64, width: 128, height: 128 };
    check(device({ viewport: { ...degenerate, minDepth: 0, maxDepth: 0 } }),
        [[128, 128, 0, 1], [192, 64, 1e-3, 1], [64, 192, 5e-4, 1], [160, 160, 2.5e-4, 1]],
        'an empty depth range is a thousandth wide');
    check(device({ viewport: { ...degenerate, minDepth: 1, maxDepth: 0 } }),
        [[128, 128, 1, 1], [192, 64, 1.001, 1], [64, 192, 1.0005, 1], [160, 160, 1.00025, 1]],
        'and so is a backwards one');
    const wide = { x: 10, y: 5, width: 246, height: 130, minDepth: -2, maxDepth: 4 };
    check(device({ viewport: wide }),
        [[133, 70, -2, 1], [256, 5, 4, 1], [10, 135, 1, 1], [194.5, 102.5, -0.5, 1]],
        'an offset viewport');
    check(device({
        viewport: wide,
        transforms: {
            [D3DTS.WORLD]: [0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1],
            [D3DTS.VIEW]: [2, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 3],
            [D3DTS.PROJECTION]: [1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1],
        },
    }), [[256, 70, -2, 0.3333], [256, 78.13, -2.75, 0.125], [256, 44, 0.4, 0.4],
        [256, 81.82, -3.091, 0.3636]], 'world, view and projection');
});

test('a destination without rhw has the last one written where the next vertex begins', ()=>{
    const s = space();
    const src = s.buffer(FVF.XYZ, 4);
    s.fill(src, QUAD);
    const dest = s.buffer(FVF.XYZ, 5);
    assert.equal(processVertices({ memory: s.memory, vertexOp: D3DVOP.TRANSFORM, dest,
        destIndex: 0, count: 4, source: s.source(src), state: device(), flags: 0 }), D3D_OK);
    near([0, 1, 2].map(i=>s.float(dest.base + 4 * 12 + i * 4)), [1, 0, 0], 'vertex 4');
    near([0, 1, 2].map(i=>s.float(dest.base + 12 + i * 4)), [192, 64, 1], 'vertex 1');
});

test('a vertex blends its world matrices by the weights it carries', ()=>{
    const s = space();
    const src = s.buffer(FVF.XYZB1, 4);
    s.fill(src, [[0, 0, 0, 0.2], [1, 1, 1, 0.5], [-1, -1, 0.5, 0.8], [0.5, -0.5, 0.25, 1]]);
    const dest = s.buffer(FVF.XYZRHW, 4);
    const state = device({
        transforms: { [D3DTS.WORLD + 1]: [0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1] },
        states: { [D3DRS.VERTEXBLEND]: 1 },
    });
    assert.equal(processVertices({ memory: s.memory, vertexOp: D3DVOP.TRANSFORM, dest,
        destIndex: 0, count: 4, source: s.source(src), state, flags: 0 }), D3D_OK);
    [[128, 76.8, 0.8, 1], [170.7, 64, 0.6667, 0.6667], [69.82, 174.5, 0.5455, 0.9091],
        [160, 160, 0.25, 1]].forEach((vertex, k)=>
        near([0, 1, 2, 3].map(i=>s.float(dest.base + k * 16 + i * 4)), vertex, `vertex ${k}`));
});

test('lighting uses the camera-space normal the inverse transpose carries, at its length', ()=>{
    // Wine's ddraw7 test_lighting, through ProcessVertices: a white light down
    // +z, and a normal facing it after each world matrix.
    const s = space();
    const light = {
        Type: D3DLIGHTTYPE.DIRECTIONAL, Diffuse: { r: 1, g: 1, b: 1, a: 0 },
        Specular: { r: 0, g: 0, b: 0, a: 0 }, Ambient: { r: 0, g: 0, b: 0, a: 0 },
        Position: { x: 0, y: 0, z: 0 }, Direction: { x: 0, y: 0, z: 1 },
        Range: 0, Falloff: 0, Attenuation0: 0, Attenuation1: 0, Attenuation2: 0, Theta: 0, Phi: 0,
    };
    const dest = s.buffer(FVF.XYZRHW | FVF.DIFFUSE | FVF.SPECULAR, 1);
    const lit = FVF.XYZ | FVF.NORMAL | FVF.DIFFUSE;
    /** @param {number} fvf @param {number[]} vertex @param {Record<number, number[]>} transforms */
    const colour = (fvf, vertex, transforms, blend = 0)=>{
        const src = s.buffer(fvf, 1);
        s.fill(src, [vertex]);
        const state = device({ transforms, lights: [light],
            states: { [D3DRS.VERTEXBLEND]: blend } });
        assert.equal(processVertices({ memory: s.memory, vertexOp: D3DVOP.TRANSFORM | D3DVOP.LIGHT,
            dest, destIndex: 0, count: 1, source: s.source(src), state, flags: 0 }), D3D_OK);
        assert.equal(s.dword(dest.base + 20), 0, 'no specular without SPECULARENABLE');
        return s.dword(dest.base + 16);
    };
    const transf = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 10, 10, 10, 1];
    assert.equal(colour(lit, [-1, -1, 0, 0, 0, -1, 0xff0000ff], {}), 0xff0000ff, 'facing it');
    assert.equal(colour(lit, [-10, -11, 11, -1, 0, 0, 0xff0000ff],
        { [D3DTS.WORLD]: transf }), 0xff0000ff, 'turned to face it');
    assert.equal(colour(lit, [-11, -11, -10, 0, 0, -1, 0xff0000ff],
        { [D3DTS.WORLD]: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 10, 10, 10, 0] }), 0xff000000,
    'a world matrix that is not affine turns the normal away');
    assert.equal(colour(FVF.XYZB1 | FVF.NORMAL | FVF.DIFFUSE,
        [-11, -11, -10, 0.2, 0, 0, -1, 0xff0000ff],
        { [D3DTS.WORLD]: transf, [D3DTS.WORLD + 1]: IDENTITY }, 1), 0xff0000cc,
    'blended normals are not renormalised');
});

test('with no light, a lit vertex is black in its own alpha, an unlit one keeps its colour', ()=>{
    // Wine's ddraw7 test_lighting: lit and unlit quads with and without normals.
    const s = space();
    const dest = s.buffer(FVF.XYZRHW | FVF.DIFFUSE | FVF.SPECULAR, 2);
    const src = s.buffer(FVF.XYZ | FVF.DIFFUSE, 2);
    s.fill(src, [[-1, -1, 0.1, 0xffff0000], [-1, 0, 0.1, 0xff00ff00]]);
    const unlitState = device({ states: { [D3DRS.LIGHTING]: 0 } });
    assert.equal(processVertices({ memory: s.memory, vertexOp: D3DVOP.TRANSFORM, dest,
        destIndex: 0, count: 1, source: s.source(src), state: unlitState, flags: 0 }), D3D_OK);
    assert.equal(s.dword(dest.base + 16), 0xffff0000);
    assert.equal(s.dword(dest.base + 20), 0);
    const one = s.source(src);
    const second = { fvf: one.fvf,
        addressOf: (/** @type {string} */ name, /** @type {number} */ k)=>one.addressOf(name, k + 1) };
    assert.equal(processVertices({ memory: s.memory, vertexOp: D3DVOP.TRANSFORM | D3DVOP.LIGHT,
        dest, destIndex: 1, count: 1, source: second, state: device(), flags: 0 }), D3D_OK);
    assert.equal(s.dword(dest.base + 24 + 16), 0xff000000);
    assert.equal(s.dword(dest.base + 24 + 20), 0);
});

test('what is refused, and what DONOTCOPYDATA leaves alone', ()=>{
    const s = space();
    const src = s.buffer(FVF.XYZ | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT), 2);
    s.fill(src, [[0, 0, 0, 0xff123456, 0.25, 0.75], [0, 0, 0, 0xff654321, 0.5, 0.5]]);
    const dest = s.buffer(FVF.XYZRHW | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT), 2);
    const run = (/** @type {number} */ op, /** @type {number} */ count, flags = 0)=>
        processVertices({ memory: s.memory, vertexOp: op, dest, destIndex: 0, count,
            source: s.source(src), state: device({ states: { [D3DRS.LIGHTING]: 0 } }), flags });
    assert.equal(run(D3DVOP.LIGHT, 1), DDERR_INVALIDPARAMS, 'the transform is always asked for');
    assert.equal(run(D3DVOP.TRANSFORM, 3), DDERR_INVALIDPARAMS, 'past the destination');
    assert.equal(run(D3DVOP.TRANSFORM, 2, D3DPV_DONOTCOPYDATA), D3D_OK);
    assert.equal(s.dword(dest.base + 16), 0, 'the colour was not copied');
    assert.equal(run(D3DVOP.TRANSFORM, 2), D3D_OK);
    assert.equal(s.dword(dest.base + 16), 0xff123456);
    assert.equal(s.float(dest.base + 20), 0.25, 'nor were the coordinates, until now');
    assert.equal(s.float(dest.base + 28 + 24), 0.5);
});
