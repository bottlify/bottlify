/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeshObjects, vertexConverter } from './mesh-object.js';
import { createMeshFunctions } from './mesh.js';
import { declarationBytes, declaratorFromFvf } from './fvf.js';
import { deviceRig } from './device.fixture.js';

const D3DERR_INVALIDCALL = 0x8876086c;
const NO = 0xffffffff;
const XYZ_NORMAL = 0x12;
const MANAGED = 0x220;
const ATTRSORT = 0x02000000;
const COMPACT = 0x01000000;

/** ID3DXMesh's slots, as a program calls them. */
const SLOT = { DrawSubset: 3, GetNumFaces: 4, GetNumVertices: 5, GetFVF: 6, GetDeclaration: 7,
    GetNumBytesPerVertex: 8, GetOptions: 9, GetDevice: 10, CloneMeshFVF: 11, CloneMesh: 12,
    GetVertexBuffer: 13, GetIndexBuffer: 14, LockVertexBuffer: 15, UnlockVertexBuffer: 16,
    LockIndexBuffer: 17, UnlockIndexBuffer: 18, GetAttributeTable: 19,
    ConvertPointRepsToAdjacency: 20, ConvertAdjacencyToPointReps: 21, GenerateAdjacency: 22,
    UpdateSemantics: 23, LockAttributeBuffer: 24, UnlockAttributeBuffer: 25, Optimize: 26,
    OptimizeInplace: 27, SetAttributeTable: 28 };

function setup(){
    const r = deviceRig();
    /** @type {Uint8Array[]} */
    const given = [];
    const meshes = createMeshObjects(r.host, { giveBuffer: (out, bytes)=>{
        given.push(bytes.slice());
        r.view.setUint32(out, 0xb0f0 + given.length, true);
        return 0;
    } });
    const out = r.heap.allocate(64);
    /** @param {number} at @param {number} count */
    const words = (at, count)=>Array.from({ length: count }, (_, i)=>
        r.view.getUint32(at + i * 4, true));
    /**
     * A mesh of the program's making, through D3DXCreateMeshFVF.
     *
     * @param {number} faces @param {number} vertices
     * @param {number} [options] @param {number} [fvf]
     */
    const make = async(faces, vertices, options = MANAGED, fvf = XYZ_NORMAL)=>{
        assert.equal(await r.call(meshes.exports.D3DXCreateMeshFVF, [faces, vertices, options,
            fvf, r.device, out]), 0);
        return r.view.getUint32(out, true);
    };
    /** A method of a mesh, through its vtable. @param {number} mesh @param {string} name */
    const call = (mesh, name, /** @type {number[]} */ rest = [])=>r.method(mesh,
        /** @type {any} */ (SLOT)[name], rest);
    /**
     * Vertices of a position and a normal, the indices and the attributes,
     * written through the mesh's own locks.
     *
     * @param {number} mesh @param {number[][]} positions @param {number[]} indices
     * @param {number[]} [attributes]
     */
    const fill = async(mesh, positions, indices, attributes = [])=>{
        const at = r.heap.allocate(4);
        assert.equal(await call(mesh, 'LockVertexBuffer', [0, at]), 0);
        positions.forEach((p, i)=>r.putFloats(r.view.getUint32(at, true) + i * 24, [...p,
            9, 9, 9]));
        await call(mesh, 'UnlockVertexBuffer');
        assert.equal(await call(mesh, 'LockIndexBuffer', [0, at]), 0);
        indices.forEach((index, i)=>r.view.setUint16(r.view.getUint32(at, true) + i * 2, index,
            true));
        await call(mesh, 'UnlockIndexBuffer');
        assert.equal(await call(mesh, 'LockAttributeBuffer', [0, at]), 0);
        attributes.forEach((a, i)=>r.view.setUint32(r.view.getUint32(at, true) + i * 4, a, true));
        await call(mesh, 'UnlockAttributeBuffer');
    };
    /** A mesh's vertex buffer's bytes as floats, `stride` bytes a vertex. */
    const vertexFloats = (/** @type {number} */ mesh, /** @type {number} */ count)=>{
        const state = /** @type {any} */ (meshes.meshAt(mesh)).state;
        return r.floats(r.objects.get(state.vb).data, count);
    };
    /** @param {number} mesh @param {number} count */
    const indicesOf = (mesh, count)=>{
        const state = /** @type {any} */ (meshes.meshAt(mesh)).state;
        const data = r.objects.get(state.ib).data;
        return Array.from({ length: count }, (_, i)=>(state.options & 1
            ? r.view.getUint32(data + i * 4, true) : r.view.getUint16(data + i * 2, true)));
    };
    return { r, meshes, given, out, words, make, call, fill, vertexFloats, indicesOf };
}

/** Two quads, one at z = 0 and one at z = 5, each two faces of its own four vertices. */
const QUADS = [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0], [0, 0, 5], [0, 1, 5], [1, 0, 5],
    [1, 1, 5]];
const QUAD_FACES = [0, 1, 2, 4, 5, 6, 2, 1, 3, 6, 5, 7];

test('D3DXCreateMeshFVF makes the buffers and the declaration on the program\'s device, and the'
    + ' mesh answers what it is', async()=>{
    const { r, meshes, out, words, make, call } = setup();
    const mesh = await make(2, 4);
    assert.ok(r.published(mesh), 'an object published');
    const made = r.calls.filter(c=>c[0].startsWith('Create')).map(c=>c.slice(0, 5));
    assert.deepEqual(made, [['CreateVertexBuffer', 96, 0, XYZ_NORMAL, 1],
        ['CreateIndexBuffer', 12, 0, 101, 1], made[2]]);
    assert.equal(made[2][0], 'CreateVertexDeclaration');
    assert.deepEqual(await Promise.all(['GetNumFaces', 'GetNumVertices', 'GetFVF',
        'GetNumBytesPerVertex', 'GetOptions'].map(name=>call(mesh, name))),
    [2, 4, XYZ_NORMAL, 24, MANAGED]);
    assert.equal(await call(mesh, 'GetDeclaration', [out]), 0);
    assert.deepEqual([...r.memory.subarray(out, out + 24)],
        [...declarationBytes(/** @type {any} */ (declaratorFromFvf(XYZ_NORMAL)))]);
    assert.equal(await call(mesh, 'GetDevice', [out]), 0);
    assert.equal(r.view.getUint32(out, true), r.device);
    assert.equal(r.objects.get(r.device).refs, 3, 'the mesh\'s reference and the caller\'s');
    assert.equal(await call(mesh, 'GetAttributeTable', [0, out]), 0);
    assert.deepEqual(words(out, 1), [0], 'no attribute table yet');

    const fns = meshes.exports;
    for (const [args, why] of /** @type {[number[], string][]} */ ([
        [[0, 4, MANAGED, XYZ_NORMAL, r.device, out], 'no faces'],
        [[2, 0, MANAGED, XYZ_NORMAL, r.device, out], 'no vertices'],
        [[2, 4, MANAGED, 0xe, r.device, out], 'an FVF with no declaration'],
        [[2, 70000, MANAGED, XYZ_NORMAL, r.device, out], 'more vertices than 16 bits reach'],
        [[2, 4, MANAGED, XYZ_NORMAL, 0, out], 'no device']]))
    {
        r.view.setUint32(out, 0xdead, true);
        assert.equal(r.call(fns.D3DXCreateMeshFVF, args), D3DERR_INVALIDCALL, why);
        assert.equal(r.view.getUint32(out, true), 0, `${why}: the mesh left null`);
    }
    assert.equal(await r.call(fns.D3DXCreateMeshFVF, [2, 70000, MANAGED | 1, XYZ_NORMAL,
        r.device, out]), 0, '32-bit indices reach them');

    // A declaration with a tangent is no FVF.
    const declaration = r.heap.allocate(64);
    const elements = /** @type {any[]} */ (declaratorFromFvf(XYZ_NORMAL));
    r.memory.set(declarationBytes([...elements, { stream: 0, offset: 24, type: 2, method: 0,
        usage: 6, usageIndex: 0 }]), declaration);
    assert.equal(await r.call(fns.D3DXCreateMesh, [1, 3, 0, declaration, r.device, out]), 0);
    const declared = r.view.getUint32(out, true);
    assert.deepEqual([await call(declared, 'GetFVF'), await call(declared,
        'GetNumBytesPerVertex')], [0, 36]);
    assert.equal(await r.call(fns.D3DXCreateMesh, [1, 3, 0, 0, r.device, out]),
        D3DERR_INVALIDCALL);
});

test('DrawSubset draws the subset\'s faces: the attribute buffer\'s runs, then the table',
    async()=>{
        const { r, out, words, make, call, fill } = setup();
        const mesh = await make(4, 8);
        await fill(mesh, QUADS, QUAD_FACES, [1, 0, 1, 0]);
        const state = r.published(mesh).state;
        r.calls.length = 0;
        assert.equal(await call(mesh, 'DrawSubset', [1]), 0);
        assert.deepEqual(r.calls, [['SetVertexDeclaration', state.declared],
            ['SetStreamSource', 0, state.vb, 0, 24], ['SetIndices', state.ib],
            ['DrawIndexedPrimitive', 4, 0, 0, 8, 0, 1],
            ['DrawIndexedPrimitive', 4, 0, 0, 8, 6, 1]]);
        r.calls.length = 0;
        assert.equal(await call(mesh, 'DrawSubset', [7]), 0);
        assert.deepEqual(r.calls, [], 'a subset of no faces draws nothing');

        const table = r.heap.allocate(20);
        [1, 0, 4, 0, 8].forEach((v, i)=>r.view.setUint32(table + i * 4, v, true));
        assert.equal(await call(mesh, 'SetAttributeTable', [table, 1]), 0);
        assert.equal(await call(mesh, 'GetAttributeTable', [out, out + 20]), 0);
        assert.deepEqual(words(out, 6), [1, 0, 4, 0, 8, 1]);
        await call(mesh, 'DrawSubset', [1]);
        assert.deepEqual(r.calls.at(-1), ['DrawIndexedPrimitive', 4, 0, 0, 8, 0, 4]);
        assert.equal(await call(mesh, 'SetAttributeTable', [0, 1]), D3DERR_INVALIDCALL);
    });

test('OptimizeInplace with ATTRSORT sorts the faces by attribute, the vertices as the faces'
    + ' first use them, and builds the attribute table', async()=>{
    const { r, given, out, words, make, call, fill, vertexFloats, indicesOf } = setup();
    const mesh = await make(4, 8);
    await fill(mesh, QUADS, QUAD_FACES, [1, 0, 1, 0]);
    const adjacency = r.heap.allocate(48);
    const remap = r.heap.allocate(16);
    assert.equal(await call(mesh, 'OptimizeInplace', [ATTRSORT, 0, adjacency, remap, out]), 0);
    assert.deepEqual(words(remap, 4), [1, 3, 0, 2], 'each new face\'s old number');
    assert.deepEqual([...new Uint32Array(given[0].buffer)], [4, 5, 6, 7, 0, 1, 2, 3],
        'each new vertex\'s old number, in a buffer');
    assert.deepEqual(indicesOf(mesh, 12), [0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7]);
    assert.deepEqual(vertexFloats(mesh, 6 * 5).filter((_, i)=>i % 6 === 2), [5, 5, 5, 5, 0],
        'the quad at z = 5 first');
    assert.deepEqual(words(adjacency, 12), [NO, 1, NO, 0, NO, NO, NO, 3, NO, 2, NO, NO],
        'from the positions, there being no adjacency given');
    assert.equal(await call(mesh, 'GetAttributeTable', [out, out + 40]), 0);
    assert.deepEqual(words(out, 11), [0, 0, 2, 0, 4, 1, 2, 2, 4, 4, 2]);
    assert.equal(await call(mesh, 'LockAttributeBuffer', [0, out]), 0);
    assert.deepEqual(words(r.view.getUint32(out, true), 4), [0, 0, 1, 1]);
    r.calls.length = 0;
    await call(mesh, 'DrawSubset', [1]);
    assert.deepEqual(r.calls.at(-1), ['DrawIndexedPrimitive', 4, 0, 4, 4, 6, 2]);

    assert.equal(await call(mesh, 'OptimizeInplace', [0, 0, 0, 0, 0]), D3DERR_INVALIDCALL,
        'no optimisation named');
    assert.equal(await call(mesh, 'OptimizeInplace', [0x0c000000, 0, 0, 0, 0]),
        D3DERR_INVALIDCALL, 'VERTEXCACHE and STRIPREORDER both');
});

test('COMPACT drops the vertices no face uses; Optimize does it all on a copy', async()=>{
    const { r, given, out, make, call, fill, indicesOf } = setup();
    const mesh = await make(2, 8);
    // Only the second quad is drawn.
    await fill(mesh, QUADS, [4, 5, 6, 6, 5, 7], [0, 0]);
    const adjacencyIn = r.heap.allocate(24);
    [NO, 1, NO, 0, NO, NO].forEach((v, i)=>r.view.setUint32(adjacencyIn + i * 4, v, true));
    const adjacencyOut = r.heap.allocate(24);
    assert.equal(await call(mesh, 'Optimize', [COMPACT | ATTRSORT | MANAGED, adjacencyIn,
        adjacencyOut, 0, out + 4, out]), 0);
    const copy = r.view.getUint32(out, true);
    assert.notEqual(copy, mesh);
    assert.equal(await call(copy, 'GetNumVertices'), 4);
    assert.equal(await call(mesh, 'GetNumVertices'), 8, 'the original as it was');
    assert.deepEqual(indicesOf(copy, 6), [0, 1, 2, 2, 1, 3]);
    assert.deepEqual([...new Uint32Array(given[0].buffer)], [4, 5, 6, 7]);
    assert.deepEqual(Array.from({ length: 6 }, (_, i)=>r.view.getUint32(adjacencyOut + i * 4,
        true)), [NO, 1, NO, 0, NO, NO]);
    assert.equal(r.view.getUint32(out + 4, true), 0xb0f1);
});

test('D3DXComputeNormals reaches a mesh of D3DX\'s own through its vtable, as a program\'s',
    async()=>{
        const { r, make, fill, vertexFloats } = setup();
        const mesh = await make(2, 4);
        await fill(mesh, QUADS.slice(0, 4), QUAD_FACES.slice(6).map(i=>i % 4).slice(0, 3)
            .concat([0, 1, 2]));
        const normals = createMeshFunctions(r.host);
        assert.equal(await r.call(normals.D3DXComputeNormals, [mesh, 0]), 0);
        const floats = vertexFloats(mesh, 24);
        for (let v = 0; v < 4; v++)
        {
            assert.deepEqual(floats.slice(v * 6 + 3, v * 6 + 6), [0, 0, -1], `vertex ${v}`);
        }
    });

test('a clone converts each vertex to its declaration and keeps the faces and attributes',
    async()=>{
        const { r, meshes, out, make, call, fill, vertexFloats, indicesOf, words } = setup();
        const mesh = await make(2, 4);
        await fill(mesh, QUADS.slice(0, 4), [0, 1, 2, 2, 1, 3], [3, 4]);
        // XYZW | NORMAL | TEX1, 32-bit indices.
        assert.equal(await call(mesh, 'CloneMeshFVF', [MANAGED | 1, 0x4112, r.device, out]), 0);
        const copy = r.view.getUint32(out, true);
        assert.deepEqual([await call(copy, 'GetNumBytesPerVertex'), await call(copy, 'GetOptions'),
            await call(copy, 'GetFVF')], [36, MANAGED | 1, 0x4112]);
        assert.deepEqual(vertexFloats(copy, 9 * 2), [0, 0, 0, 1, 9, 9, 9, 0, 0,
            0, 1, 0, 1, 9, 9, 9, 0, 0], 'w 1, the normal kept, the texture coordinates 0');
        assert.deepEqual(indicesOf(copy, 6), [0, 1, 2, 2, 1, 3]);
        assert.equal(await call(copy, 'LockAttributeBuffer', [0, out]), 0);
        assert.deepEqual(words(r.view.getUint32(out, true), 2), [3, 4]);

        const declaration = r.heap.allocate(64);
        r.memory.set(declarationBytes([{ stream: 0, offset: 0, type: 2, method: 0, usage: 0,
            usageIndex: 0 }]), declaration);
        assert.equal(await call(mesh, 'CloneMesh', [0, declaration, r.device, out]), 0);
        const positions = meshes.meshAt(r.view.getUint32(out, true));
        assert.equal(positions?.state.stride, 12);
        assert.equal(await call(mesh, 'CloneMeshFVF', [0, 0xe, r.device, out]),
            D3DERR_INVALIDCALL);
        assert.equal(r.view.getUint32(out, true), 0);

        const convert = vertexConverter(/** @type {any} */ (declaratorFromFvf(0x42)),
            /** @type {any} */ ([{ stream: 0, offset: 0, type: 3, method: 0, usage: 10,
                usageIndex: 0 }]));
        const from = new DataView(Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            51, 102, 255, 0).buffer);
        const to = new DataView(new ArrayBuffer(16));
        convert(from, to);
        assert.deepEqual([0, 1, 2, 3].map(k=>to.getFloat32(k * 4, true)),
            [1, 0.4, 0.2, 0].map(Math.fround),
            'a colour, B G R A in memory, as R G B A floats');
    });

test('adjacency and point representatives, each from the other and from the positions',
    async()=>{
        const { r, out, words, make, call, fill } = setup();
        // A quad whose two faces have vertices of their own at the shared edge.
        const mesh = await make(2, 6);
        await fill(mesh, [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]],
            [0, 1, 2, 3, 4, 5]);
        const adjacency = r.heap.allocate(24);
        assert.equal(await call(mesh, 'GenerateAdjacency', [0, adjacency]), 0);
        assert.deepEqual(words(adjacency, 6), [NO, 1, NO, 0, NO, NO]);
        assert.equal(await call(mesh, 'ConvertAdjacencyToPointReps', [adjacency, out]), 0);
        assert.deepEqual(words(out, 6), [0, 1, 2, 2, 1, 5]);
        assert.equal(await call(mesh, 'ConvertPointRepsToAdjacency', [out, adjacency]), 0);
        assert.deepEqual(words(adjacency, 6), [NO, 1, NO, 0, NO, NO]);
        assert.equal(await call(mesh, 'ConvertPointRepsToAdjacency', [0, adjacency]), 0);
        assert.deepEqual(words(adjacency, 6), new Array(6).fill(NO), 'every vertex its own point');
        assert.equal(await call(mesh, 'ConvertAdjacencyToPointReps', [0, out]),
            D3DERR_INVALIDCALL);
        assert.equal(await call(mesh, 'GenerateAdjacency', [0xbf800000, adjacency]),
            D3DERR_INVALIDCALL, 'a negative epsilon');
    });

test('the last Release lets go of the buffers, the declaration and the device', async()=>{
    const { r, out, make, call } = setup();
    const mesh = await make(1, 3);
    const state = r.published(mesh).state;
    assert.equal(await call(mesh, 'GetVertexBuffer', [out]), 0);
    assert.equal(r.view.getUint32(out, true), state.vb);
    await r.method(state.vb, 2, []);
    const device = r.objects.get(r.device).refs;
    assert.equal(await r.method(mesh, 2, []), 0);
    assert.equal(r.published(mesh).destroyed, true);
    for (const held of [state.vb, state.ib, state.declared])
    {
        assert.equal(r.objects.get(held).refs, 0, 'released');
    }
    assert.equal(r.objects.get(r.device).refs, device - 1);
});

test('UpdateSemantics reads the same vertices another way, and refuses a wider declaration',
    async()=>{
        const { r, out, make, call } = setup();
        const mesh = await make(1, 3);
        const declaration = r.heap.allocate(64);
        const elements = /** @type {any[]} */ (declaratorFromFvf(XYZ_NORMAL));
        r.memory.set(declarationBytes([elements[0], { ...elements[1], usage: 7 }]), declaration);
        assert.equal(await call(mesh, 'UpdateSemantics', [declaration]), 0);
        assert.equal(await call(mesh, 'GetFVF'), 0, 'a binormal is no FVF');
        assert.equal(await call(mesh, 'GetDeclaration', [out]), 0);
        assert.equal(r.memory[out + 8 + 6], 7);
        r.memory.set(declarationBytes([elements[0], { ...elements[1], offset: 16 }]),
            declaration);
        assert.equal(await call(mesh, 'UpdateSemantics', [declaration]), D3DERR_INVALIDCALL);
    });
