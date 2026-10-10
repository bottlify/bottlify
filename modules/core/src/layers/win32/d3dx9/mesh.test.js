/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeshFunctions, indexBufferOf, singleStrip, vertexNormals } from './mesh.js';
import { deviceRig } from './device.fixture.js';

const D3DERR_INVALIDCALL = 0x8876086c;
const VERTICES = 0x100;
const OUT = 0x800;
const OUT2 = 0x900;

/** Flat guest memory and the mesh functions over it. */
function flat(){
    const memory = new Uint8Array(0x10000);
    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            memory.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, at),
    };
    /** @param {number} at @param {number[]} values */
    const putFloats = (at, values)=>new Float32Array(memory.buffer, at, values.length)
        .set(values);
    /** @param {number} at @param {number} count */
    const floats = (at, count)=>[...new Float32Array(memory.buffer.slice(at, at + count * 4))];
    return { api: /** @type {any} */ (createMeshFunctions(host)), memory, putFloats, floats };
}

/**
 * Positions written `stride` bytes apart, with something else between them
 * that must not be read as a position.
 *
 * @param {ReturnType<typeof flat>} m @param {number[][]} positions @param {number} stride
 */
function place(m, positions, stride){
    positions.forEach((p, i)=>{
        m.putFloats(VERTICES + i * stride, p);
        if (stride >= 16)
        {
            m.putFloats(VERTICES + i * stride + 12, [1e9]);
        }
    });
}

const POSITIONS = [[1, -2, 3], [-4, 5, 0.5], [2, 2, -6], [0, 0, 0]];

test('D3DXComputeBoundingBox takes the extremes of each axis over the strided run', ()=>{
    const m = flat();
    place(m, POSITIONS, 24);
    assert.equal(m.api.D3DXComputeBoundingBox.argBytes, 20);
    assert.equal(m.api.D3DXComputeBoundingBox.handler([VERTICES, 4, 24, OUT, OUT2]), 0);
    assert.deepEqual(m.floats(OUT, 3), [-4, -2, -6]);
    assert.deepEqual(m.floats(OUT2, 3), [2, 5, 3]);
    // One vertex: both corners on it.
    assert.equal(m.api.D3DXComputeBoundingBox.handler([VERTICES, 1, 24, OUT, OUT2]), 0);
    assert.deepEqual([m.floats(OUT, 3), m.floats(OUT2, 3)], [[1, -2, 3], [1, -2, 3]]);
});

test('D3DXComputeBoundingSphere is centred on the mean, out to the farthest position', ()=>{
    const m = flat();
    place(m, [[0, 0, 0], [2, 0, 0], [0, 4, 0], [2, 4, 0]], 12);
    assert.equal(m.api.D3DXComputeBoundingSphere.argBytes, 20);
    assert.equal(m.api.D3DXComputeBoundingSphere.handler([VERTICES, 4, 12, OUT, OUT2]), 0);
    assert.deepEqual(m.floats(OUT, 3), [1, 2, 0]);
    assert.deepEqual(m.floats(OUT2, 1), [Math.fround(Math.sqrt(5))]);
    // Not the smallest sphere: a far-off point drags the mean, not just the radius.
    const n = flat();
    place(n, [[0, 0, 0], [0, 0, 0], [0, 0, 0], [8, 0, 0]], 16);
    n.api.D3DXComputeBoundingSphere.handler([VERTICES, 4, 16, OUT, OUT2]);
    assert.deepEqual(n.floats(OUT, 3), [2, 0, 0]);
    assert.deepEqual(n.floats(OUT2, 1), [6]);
});

test('the bounds refuse a null position, corner, centre or radius pointer', ()=>{
    const m = flat();
    place(m, POSITIONS, 12);
    for (const name of ['D3DXComputeBoundingBox', 'D3DXComputeBoundingSphere'])
    {
        for (const args of [[0, 4, 12, OUT, OUT2], [VERTICES, 4, 12, 0, OUT2],
            [VERTICES, 4, 12, OUT, 0]])
        {
            assert.equal(m.api[name].handler(args), D3DERR_INVALIDCALL, `${name} ${args}`);
        }
    }
});

test('a vertex\'s normal weights each face around it by the face\'s angle there', ()=>{
    const positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1]];
    // A right angle in the xy plane facing +z, an eighth turn in the xz plane facing +y.
    const normals = vertexNormals(positions, [0, 1, 2, 0, 3, 4], [0, 1, 2, 3, 4]);
    const expected = [0, 1 / Math.sqrt(5), 2 / Math.sqrt(5)];
    normals[0].forEach((value, i)=>assert.ok(Math.abs(value - expected[i]) < 1e-12));
    assert.deepEqual(normals[2], [0, 0, 1]);
    // The same point twice, said to be one: both carry what both faces make.
    const split = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [0, 0, 0]];
    const joined = vertexNormals(split, [0, 1, 2, 5, 3, 4], [0, 1, 2, 3, 4, 0]);
    assert.deepEqual(joined[5], joined[0]);
    joined[0].forEach((value, i)=>assert.ok(Math.abs(value - expected[i]) < 1e-12));
    assert.deepEqual(vertexNormals(split, [0, 1, 2, 5, 3, 4], [0, 1, 2, 3, 4, 5])[5],
        [0, 1, 0], 'apart without the adjacency');
    assert.deepEqual(vertexNormals([[0, 0, 0], [1, 0, 0], [2, 0, 0]], [0, 1, 2], [0, 1, 2]),
        [[0, 0, 0], [0, 0, 0], [0, 0, 0]], 'a face with no area adds nothing');
});

/** A quad of two faces in the xy plane, position then normal, 24 bytes a vertex. */
const QUAD = { declaration: [[0, 0, 2, 0, 0, 0], [0, 12, 2, 0, 3, 0]], stride: 24, vertices: 4,
    indices: [0, 1, 2, 0, 2, 3] };

/** @param {ReturnType<typeof deviceRig>} r @param {number} mesh */
function placeQuad(r, mesh){
    const { vertexData } = r.objects.get(mesh);
    [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].forEach((p, i)=>
        r.putFloats(vertexData + i * 24, [...p, 9, 9, 9]));
    return vertexData;
}

test('D3DXComputeNormals writes each vertex\'s normal through the mesh\'s own locks', async()=>{
    const r = deviceRig();
    const api = /** @type {any} */ (createMeshFunctions(r.host));
    const mesh = r.mesh(QUAD);
    const data = placeQuad(r, mesh);
    assert.equal(api.D3DXComputeNormals.argBytes, 8);
    assert.equal(await r.call(api.D3DXComputeNormals, [mesh, 0]), 0);
    for (let i = 0; i < 4; i++)
    {
        assert.deepEqual(r.floats(data + i * 24, 6), [...r.floats(data + i * 24, 3), 0, 0, 1]);
    }
    assert.equal(r.objects.get(mesh).locks, 0, 'every lock undone');
    assert.ok(r.calls.some(c=>c[0] === 'LockIndexBuffer' && c[1] === 0x10), 'indices read-only');
    assert.ok(!r.calls.some(c=>c[0] === 'ConvertAdjacencyToPointReps'));
    const adjacency = r.heap.allocate(24);
    assert.equal(await r.call(api.D3DXComputeNormals, [mesh, adjacency]), 0);
    assert.deepEqual(r.calls.find(c=>c[0] === 'ConvertAdjacencyToPointReps')?.[1], adjacency);
});

test('D3DXComputeNormals refuses no mesh, and a mesh without a position or normal', async()=>{
    const r = deviceRig();
    const api = /** @type {any} */ (createMeshFunctions(r.host));
    assert.equal(r.call(api.D3DXComputeNormals, [0, 0]), D3DERR_INVALIDCALL);
    const bare = r.mesh({ ...QUAD, declaration: [[0, 0, 2, 0, 0, 0]], stride: 12 });
    assert.equal(await r.call(api.D3DXComputeNormals, [bare, 0]), D3DERR_INVALIDCALL);
    const packed = r.mesh({ ...QUAD, declaration: [[0, 0, 2, 0, 0, 0], [0, 12, 15, 0, 3, 0]],
        stride: 20 });
    assert.equal(await r.call(api.D3DXComputeNormals, [packed, 0]), 0x80004001,
        'a packed normal is told, not guessed at');
    assert.equal(r.diverged.at(-1)?.[0], 'D3DXComputeNormals');
});

/**
 * The triangles a strip draws, each as it winds, its lowest index first;
 * those with no area left out.
 *
 * @param {number[]} strip
 */
function stripTriangles(strip){
    /** @type {string[]} */
    const drawn = [];
    for (let t = 0; t + 2 < strip.length; t++)
    {
        const [a, b, c] = t % 2 === 0 ? [strip[t], strip[t + 1], strip[t + 2]]
            : [strip[t + 1], strip[t], strip[t + 2]];
        if (a !== b && b !== c && a !== c)
        {
            drawn.push(canonical([a, b, c]));
        }
    }
    return drawn.sort();
}

/** A triangle turned so its lowest index is first, its winding kept. @param {number[]} t */
function canonical(t){
    const k = t.indexOf(Math.min(...t));
    return [t[k], t[(k + 1) % 3], t[(k + 2) % 3]].join(',');
}

test('singleStrip draws exactly the faces it is given, each with its own winding', ()=>{
    let seed = 7;
    const next = ()=>{
        seed = (seed * 1103515245 + 12345) >>> 0;
        return seed >>> 16;
    };
    for (let round = 0; round < 200; round++)
    {
        const faces = Array.from({ length: 1 + next() % 12 }, ()=>{
            const a = next() % 50;
            const b = (a + 1 + next() % 48) % 50;
            let c = next() % 50;
            while (c === a || c === b)
            {
                c = (c + 1) % 50;
            }
            return [a, b, c];
        });
        assert.deepEqual(stripTriangles(singleStrip(faces)), faces.map(canonical).sort(),
            JSON.stringify(faces));
    }
});

test('the index buffer is made as the IB_ options and 32BIT ask', ()=>{
    assert.deepEqual(indexBufferOf(0), { usage: 0, pool: 0, format: 101 });
    assert.deepEqual(indexBufferOf(0x1 | 0x200 | 0x400), { usage: 0x8, pool: 1, format: 102 });
    assert.deepEqual(indexBufferOf(0x110 | 0x880 | 0x40), { usage: 0x200, pool: 2, format: 101 },
        'SYSTEMMEM and DYNAMIC count for both; VB_WRITEONLY is the vertex buffer\'s alone');
});

test('D3DXConvertMeshSubsetToSingleStrip strips the faces of one attribute', async()=>{
    const r = deviceRig();
    const api = /** @type {any} */ (createMeshFunctions(r.host));
    const mesh = r.mesh({ ...QUAD, vertices: 6, indices: [0, 1, 2, 0, 2, 3, 3, 4, 5],
        ranges: [[0, 0, 1, 0, 3], [1, 1, 2, 0, 6]] });
    const out = r.heap.allocate(8);
    assert.equal(api.D3DXConvertMeshSubsetToSingleStrip.argBytes, 20);
    assert.equal(await r.call(api.D3DXConvertMeshSubsetToSingleStrip, [mesh, 1, 0x200, out,
        out + 4]), 0);
    const buffer = r.objects.get(r.view.getUint32(out, true));
    const count = r.view.getUint32(out + 4, true);
    const strip = [...new Uint16Array(r.memory.buffer, buffer.data, count)];
    assert.deepEqual(stripTriangles(strip), ['0,2,3', '3,4,5']);
    assert.deepEqual([buffer.format, buffer.pool, buffer.length], [101, 1, count * 2]);
    assert.equal(r.objects.get(r.device).refs, 1, 'the device GetDevice gave is let go');
    assert.equal(r.objects.get(mesh).locks, 0);
    assert.equal(await r.call(api.D3DXConvertMeshSubsetToSingleStrip, [mesh, 7, 0, out, 0]),
        D3DERR_INVALIDCALL, 'an attribute with no faces');
    assert.equal(r.view.getUint32(out, true), 0);
    const untabled = r.mesh(QUAD);
    assert.equal(await r.call(api.D3DXConvertMeshSubsetToSingleStrip, [untabled, 0, 0, out,
        0]), 0x80004001);
    assert.equal(r.diverged.at(-1)?.[0], 'D3DXConvertMeshSubsetToSingleStrip');
    assert.equal(r.call(api.D3DXConvertMeshSubsetToSingleStrip, [0, 0, 0, out, 0]),
        D3DERR_INVALIDCALL);
});

test('D3DXValidMesh finds fault with indices past the vertices and an adjacency that does not'
    + ' agree with itself; D3DXCleanMesh answers a sound mesh with itself', async()=>{
    const r = deviceRig();
    /** @type {string[]} */
    const told = [];
    const api = /** @type {any} */ (createMeshFunctions(r.host, { giveBuffer: (out, bytes)=>{
        told.push(String.fromCharCode(...bytes.subarray(0, bytes.length - 1)));
        r.view.setUint32(out, 0xb0f, true);
        return 0;
    } }));
    const mesh = r.mesh({ declaration: [[0, 0, 2, 0, 0, 0]], stride: 12, vertices: 4,
        indices: [0, 1, 2, 2, 1, 3] });
    const adjacency = r.heap.allocate(24);
    const put = (/** @type {number[]} */ words)=>words.forEach((w, i)=>
        r.view.setUint32(adjacency + i * 4, w, true));
    const NO = 0xffffffff;
    put([NO, 1, NO, 0, NO, NO]);
    const out = r.heap.allocate(16);
    r.view.setUint32(out, 0xdead, true);
    assert.equal(await r.call(api.D3DXValidMesh, [mesh, adjacency, out]), 0);
    assert.equal(r.view.getUint32(out, true), 0, 'nothing to say');
    assert.equal(api.D3DXValidMesh.argBytes, 12);

    put([NO, 1, NO, NO, NO, 7]);
    assert.equal(await r.call(api.D3DXValidMesh, [mesh, adjacency, out]), 0x88760b55);
    assert.equal(r.view.getUint32(out, true), 0xb0f);
    assert.deepEqual(told[0].split('\n'), ['face 0 names face 1 as a neighbour, which does not '
        + 'name it back', 'face 1\'s neighbour 7 is no face of the mesh', '']);
    assert.equal(r.call(api.D3DXValidMesh, [mesh, 0, out]), D3DERR_INVALIDCALL);

    put([NO, 1, NO, 0, NO, NO]);
    const adjacencyOut = r.heap.allocate(24);
    const refs = r.objects.get(mesh).refs;
    assert.equal(api.D3DXCleanMesh.argBytes, 24);
    assert.equal(await r.call(api.D3DXCleanMesh, [1, mesh, adjacency, out, adjacencyOut, out + 4]),
        0);
    assert.equal(r.view.getUint32(out, true), mesh, 'the same mesh');
    assert.equal(r.objects.get(mesh).refs, refs + 1, 'a reference the caller releases');
    assert.deepEqual(Array.from({ length: 6 }, (_, i)=>r.view.getUint32(adjacencyOut + i * 4,
        true)), [NO, 1, NO, 0, NO, NO]);
    assert.equal(r.view.getUint32(out + 4, true), 0, 'no messages');

    const broken = r.mesh({ declaration: [[0, 0, 2, 0, 0, 0]], stride: 12, vertices: 2,
        indices: [0, 1, 2] });
    put([NO, NO, NO]);
    assert.equal(await r.call(api.D3DXCleanMesh, [1, broken, adjacency, out, 0, out + 4]),
        0x88760b55);
    assert.equal(r.view.getUint32(out, true), 0, 'no mesh out');
    assert.equal(told.at(-1), 'face 0 uses vertex 2, past the mesh\'s 2\n');
});
