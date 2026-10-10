/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { box, createShapes, cylinder, polygon, sphere, torus } from './shapes.js';
import { createMeshObjects } from './mesh-object.js';
import { deviceRig } from './device.fixture.js';

const D3DERR_INVALIDCALL = 0x8876086c;
const NO = 0xffffffff;

/** @param {number} value  A FLOAT argument, as the dword the bridge reads. */
const bits = value=>new Uint32Array(Float32Array.of(value).buffer)[0];

/**
 * What every shape owes: each face wound clockwise seen from outside --
 * its edges' cross product along its corners' normals -- unit normals,
 * and every index a vertex.
 *
 * @param {import('./shapes.js').Shape} shape @param {string} name
 */
function wellMade(shape, name){
    const { positions, normals, indices } = shape;
    assert.equal(positions.length, normals.length, name);
    assert.ok(indices.every(i=>i >= 0 && i < positions.length), `${name}: indices in range`);
    for (const n of normals)
    {
        assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-9, `${name}: a unit normal`);
    }
    for (let face = 0; face < indices.length; face += 3)
    {
        const [a, b, c] = indices.slice(face, face + 3).map(i=>positions[i]);
        const e1 = [0, 1, 2].map(k=>b[k] - a[k]);
        const e2 = [0, 1, 2].map(k=>c[k] - a[k]);
        const turned = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0]];
        const out = [0, 1, 2].map(k=>indices.slice(face, face + 3).reduce((sum, i)=>
            sum + normals[i][k], 0));
        assert.ok(turned[0] * out[0] + turned[1] * out[1] + turned[2] * out[2] > 0,
            `${name}: face ${face / 3} faces out`);
    }
}

test('each shape has the vertices and faces its description gives, every face facing out', ()=>{
    const made = { box: box(2, 4, 6), sphere: sphere(1, 6, 4), cylinder: cylinder(1, 2, 3, 5, 2),
        torus: torus(0.5, 2, 4, 6), polygon: polygon(1, 5) };
    const counts = Object.fromEntries(Object.entries(made).map(([name, shape])=>{
        wellMade(shape, name);
        return [name, [shape.positions.length, shape.indices.length / 3]];
    }));
    assert.deepEqual(counts, { box: [24, 12], sphere: [6 * 3 + 2, 2 * 6 * 3],
        cylinder: [5 * (2 + 3) + 2, 2 * 5 * 3], torus: [24, 48], polygon: [6, 5] });
    const extent = (/** @type {number[][]} */ points, /** @type {number} */ k)=>
        [Math.min(...points.map(p=>p[k])), Math.max(...points.map(p=>p[k]))];
    assert.deepEqual([0, 1, 2].map(k=>extent(made.box.positions, k)), [[-1, 1], [-2, 2], [-3, 3]]);
    assert.ok(made.sphere.positions.every(p=>Math.abs(Math.hypot(...p) - 1) < 1e-9));
    assert.deepEqual(extent(made.cylinder.positions, 2), [-1.5, 1.5]);
    const radius = (/** @type {number[]} */ p)=>Math.hypot(p[0], p[1]);
    assert.ok(made.cylinder.positions.filter(p=>p[2] === -1.5 && radius(p) > 0)
        .every(p=>Math.abs(radius(p) - 1) < 1e-9), 'Radius1 at the negative end');
    assert.ok(made.torus.positions.every(p=>Math.abs(Math.hypot(radius(p) - 2, p[2]) - 0.5)
        < 1e-9), 'the tube InnerRadius about a ring OuterRadius out');
    const corners = made.polygon.positions.slice(1);
    assert.ok(corners.every((p, i)=>{
        const q = corners[(i + 1) % corners.length];
        return Math.abs(Math.hypot(q[0] - p[0], q[1] - p[1]) - 1) < 1e-9;
    }), 'sides of the length asked');
    assert.ok(made.polygon.normals.every(n=>n[2] === 1), 'facing +Z');
});

test('D3DXCreateBox makes a managed XYZ | NORMAL mesh of one subset, and its adjacency', async()=>{
    const r = deviceRig();
    /** @type {Uint8Array[]} */
    const given = [];
    const giveBuffer = (/** @type {number} */ out, /** @type {Uint8Array} */ bytes)=>{
        given.push(bytes.slice());
        r.view.setUint32(out, 0xb0f, true);
        return 0;
    };
    const meshes = createMeshObjects(r.host, { giveBuffer });
    const shapes = createShapes(r.host, meshes, { giveBuffer });
    const out = r.heap.allocate(8);
    assert.equal(await r.call(shapes.D3DXCreateBox, [r.device, bits(2), bits(2), bits(2), out,
        out + 4]), 0);
    const mesh = r.view.getUint32(out, true);
    const state = /** @type {any} */ (meshes.meshAt(mesh)).state;
    assert.deepEqual([state.faces, state.vertices, state.fvf, state.options, state.stride],
        [12, 24, 0x12, 0x220, 24]);
    assert.deepEqual(state.table, [{ id: 0, faceStart: 0, faceCount: 12, vertexStart: 0,
        vertexCount: 24 }]);
    const vertex = r.floats(r.objects.get(state.vb).data, 6);
    assert.deepEqual(vertex, [-1, -1, -1, -1, 0, 0], 'a corner of the -X side, its normal');
    assert.equal(r.view.getUint32(out + 4, true), 0xb0f);
    const adjacency = [...new Uint32Array(given[0].buffer)];
    assert.equal(adjacency.length, 36);
    assert.ok(adjacency.every(face=>face !== NO && face < 12), 'a closed box: every edge shared');
    adjacency.forEach((other, i)=>assert.ok(adjacency.slice(other * 3, other * 3 + 3)
        .includes(Math.floor(i / 3)), 'each neighbour names the face back'));

    assert.equal(await r.call(shapes.D3DXCreateSphere, [r.device, bits(1), 8, 4, out, 0]), 0);
    assert.equal(meshes.meshAt(r.view.getUint32(out, true))?.state.faces, 48);
    assert.equal(await r.call(shapes.D3DXCreateCylinder, [r.device, bits(1), bits(1), bits(2), 8,
        1, out, 0]), 0);
    assert.equal(await r.call(shapes.D3DXCreateTorus, [r.device, bits(1), bits(2), 8, 8, out,
        0]), 0);
    assert.equal(await r.call(shapes.D3DXCreatePolygon, [r.device, bits(1), 3, out, 0]), 0);
    assert.equal(meshes.meshAt(r.view.getUint32(out, true))?.state.faces, 3);

    for (const [name, args] of /** @type {[string, number[]][]} */ ([
        ['D3DXCreateBox', [r.device, bits(-1), bits(1), bits(1), out, out + 4]],
        ['D3DXCreateSphere', [r.device, bits(1), 1, 4, out, out + 4]],
        ['D3DXCreateCylinder', [r.device, bits(1), bits(1), bits(1), 8, 0, out, out + 4]],
        ['D3DXCreateTorus', [r.device, bits(1), bits(1), 2, 8, out, out + 4]],
        ['D3DXCreatePolygon', [r.device, bits(1), 2, out, out + 4]],
        ['D3DXCreateBox', [0, bits(1), bits(1), bits(1), out, out + 4]]]))
    {
        r.view.setUint32(out, 0xdead, true);
        r.view.setUint32(out + 4, 0xdead, true);
        assert.equal(r.call(/** @type {any} */ (shapes)[name], args), D3DERR_INVALIDCALL, name);
        assert.deepEqual([r.view.getUint32(out, true), r.view.getUint32(out + 4, true)], [0, 0],
            `${name}: both out-pointers null`);
    }
    assert.equal(r.call(shapes.D3DXCreateSphere, [r.device, bits(1), 0x10000, 0x10000, out, 0]),
        0x8007000e, 'more vertices than are made');
});
