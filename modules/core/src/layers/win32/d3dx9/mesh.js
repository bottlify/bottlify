/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createDeviceCalls } from './device.js';

/**
 * D3DX's geometry over vertex data: the bounds of a run of positions, and
 * what D3DX does to a mesh -- its normals computed.
 *
 * Positions are D3DXVECTOR3, three floats at the start of each vertex, the
 * vertices `stride` bytes apart. The bounds' arithmetic is single precision,
 * rounded after every operation, as D3DX does it in float.
 *
 * This library makes no mesh of its own, so a mesh is one the program holds
 * -- its own implementation of ID3DXBaseMesh -- and is reached only through
 * its vtable, the way D3DX reaches any mesh: the declaration, the counts and
 * options, the locked vertex and index buffers, the attribute table, and the
 * point representatives it derives from an adjacency.
 */

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const E_NOTIMPL = 0x80004001;
const E_OUTOFMEMORY = 0x8007000e;

/** ID3DXBaseMesh's slots, after IUnknown's three, in d3dx9mesh.h's order. */
export const MESH = Object.freeze({ GetNumFaces: 4, GetNumVertices: 5, GetDeclaration: 7,
    GetNumBytesPerVertex: 8, GetOptions: 9, GetDevice: 10, LockVertexBuffer: 15,
    UnlockVertexBuffer: 16, LockIndexBuffer: 17, UnlockIndexBuffer: 18, GetAttributeTable: 19,
    ConvertAdjacencyToPointReps: 21 });

/** MAX_FVF_DECL_SIZE elements of D3DVERTEXELEMENT9, eight bytes each. */
const DECLARATION_BYTES = 65 * 8;
const D3DDECLTYPE_FLOAT3 = 2;
const D3DDECLTYPE_FLOAT4 = 3;
const D3DDECLTYPE_UNUSED = 17;
const D3DDECLUSAGE_POSITION = 0;
const D3DDECLUSAGE_NORMAL = 3;
const D3DLOCK_READONLY = 0x10;
const D3DXMESH_32BIT = 0x1;

/**
 * Each vertex's normal: the normals of the faces around it, each weighted by
 * the face's angle at it, summed over every vertex with the same point
 * representative, and made unit length. A face with no area adds nothing; a
 * vertex no face reaches is left zero.
 *
 * @param {number[][]} positions @param {number[]} indices  Three a face.
 * @param {number[]} reps  Each vertex's representative.
 * @returns {number[][]}
 */
export function vertexNormals(positions, indices, reps){
    const sums = positions.map(()=>[0, 0, 0]);
    /** @param {number[]} u @param {number[]} v */
    const minus = (u, v)=>[u[0] - v[0], u[1] - v[1], u[2] - v[2]];
    /** @param {number[]} u @param {number[]} v */
    const dot = (u, v)=>u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    /** @param {number[]} u */
    const unit = u=>{
        const length = Math.hypot(u[0], u[1], u[2]);
        return length === 0 ? null : u.map(c=>c / length);
    };
    for (let face = 0; face + 2 < indices.length; face += 3)
    {
        const corners = indices.slice(face, face + 3);
        const [p0, p1, p2] = corners.map(i=>positions[i]);
        const e1 = minus(p1, p0);
        const e2 = minus(p2, p0);
        const normal = unit([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0]]);
        if (!normal)
        {
            continue;
        }
        corners.forEach((vertex, k)=>{
            const here = positions[vertex];
            const a = unit(minus(positions[corners[(k + 1) % 3]], here));
            const b = unit(minus(positions[corners[(k + 2) % 3]], here));
            if (!a || !b)
            {
                return;
            }
            const angle = Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
            const sum = sums[reps[vertex]];
            for (let c = 0; c < 3; c++)
            {
                sum[c] += normal[c] * angle;
            }
        });
    }
    return positions.map((_, vertex)=>unit(sums[reps[vertex]]) ?? [0, 0, 0]);
}

/**
 * @typedef {Object} MeshHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 * @property {() => any} [currentThread]
 */

/**
 * @param {MeshHost} host
 */
export function createMeshFunctions(host){
    const f = Math.fround;
    /** @param {number} at @returns {[number, number, number]} */
    const position = at=>{
        const view = new DataView(host.readMemory(at >>> 0, 12).slice().buffer);
        return [view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true)];
    };
    /** @param {number} at @param {number[]} values */
    const putFloats = (at, values)=>host.writeMemory(at >>> 0,
        new Uint8Array(Float32Array.from(values).buffer));
    const { u32, putU32s, method } = createDeviceCalls(host);

    /**
     * Scratch memory for a call's out-values, given back however the work ends.
     *
     * @template T
     * @param {number} bytes @param {(at: number) => Promise<T>} work
     * @returns {Promise<T | number>}
     */
    const withScratch = async(bytes, work)=>{
        const heap = /** @type {NonNullable<MeshHost['heap']>} */ (host.heap);
        const at = heap.allocate(bytes);
        if (at === 0)
        {
            return E_OUTOFMEMORY;
        }
        try
        {
            return await work(at);
        }
        finally
        {
            heap.free(at);
        }
    };

    /**
     * A mesh's faces, as its index buffer holds them, read through a lock.
     *
     * @param {number} mesh @param {any} thread @param {number} at  Four bytes of scratch.
     * @returns {Promise<number[] | number>}
     */
    const indicesOf = async(mesh, thread, at)=>{
        const faces = await method(thread, mesh, MESH.GetNumFaces, []);
        const wide = (await method(thread, mesh, MESH.GetOptions, []) & D3DXMESH_32BIT) !== 0;
        putU32s(at, [0]);
        const locked = await method(thread, mesh, MESH.LockIndexBuffer, [D3DLOCK_READONLY, at]);
        if (locked !== D3D_OK)
        {
            return locked;
        }
        const bytes = host.readMemory(u32(at), faces * 3 * (wide ? 4 : 2)).slice();
        await method(thread, mesh, MESH.UnlockIndexBuffer, []);
        return [...(wide ? new Uint32Array(bytes.buffer) : new Uint16Array(bytes.buffer))];
    };

    /**
     * D3DXComputeNormals's work, once its handler has returned.
     *
     * @param {number} mesh @param {number} adjacency @param {any} thread
     * @returns {Promise<number>}
     */
    const computeNormals = async(mesh, adjacency, thread)=>{
        await null;
        const vertices = await method(thread, mesh, MESH.GetNumVertices, []);
        const answer = await withScratch(DECLARATION_BYTES + 4 + vertices * 4, async at=>{
            const declared = await method(thread, mesh, MESH.GetDeclaration, [at]);
            if (declared !== D3D_OK)
            {
                return declared;
            }
            /** @type {Map<number, { offset: number, type: number }>} */
            const elements = new Map();
            for (let i = 0; i < 65; i++)
            {
                const row = host.readMemory(at + i * 8, 8);
                if (row[4] === D3DDECLTYPE_UNUSED || (row[0] | row[1] << 8) === 0xff)
                {
                    break;
                }
                // Stream 0, usage index 0: the position and normal D3DX reads.
                if ((row[0] | row[1] << 8) === 0 && row[7] === 0 && !elements.has(row[6]))
                {
                    elements.set(row[6], { offset: row[2] | row[3] << 8, type: row[4] });
                }
            }
            const where = elements.get(D3DDECLUSAGE_POSITION);
            const normal = elements.get(D3DDECLUSAGE_NORMAL);
            if (!where || !normal || (where.type !== D3DDECLTYPE_FLOAT3
                && where.type !== D3DDECLTYPE_FLOAT4))
            {
                return D3DERR_INVALIDCALL;
            }
            if (normal.type !== D3DDECLTYPE_FLOAT3)
            {
                host.divergence?.('D3DXComputeNormals', `a normal of declaration type ${
                    normal.type}: answered E_NOTIMPL`);
                return E_NOTIMPL;
            }
            const out = at + DECLARATION_BYTES;
            const repsAt = out + 4;
            const indices = await indicesOf(mesh, thread, out);
            if (typeof indices === 'number')
            {
                return indices;
            }
            /** @type {number[]} */
            let reps = Array.from({ length: vertices }, (_, i)=>i);
            if ((adjacency >>> 0) !== 0)
            {
                const converted = await method(thread, mesh, MESH.ConvertAdjacencyToPointReps,
                    [adjacency >>> 0, repsAt]);
                if (converted !== D3D_OK)
                {
                    return converted;
                }
                reps = [...new Uint32Array(host.readMemory(repsAt, vertices * 4).slice().buffer)]
                    .map((rep, i)=>(rep < vertices ? rep : i));
            }
            const stride = await method(thread, mesh, MESH.GetNumBytesPerVertex, []);
            putU32s(out, [0]);
            const locked = await method(thread, mesh, MESH.LockVertexBuffer, [0, out]);
            if (locked !== D3D_OK)
            {
                return locked;
            }
            const data = u32(out);
            const positions = Array.from({ length: vertices }, (_, i)=>
                position(data + i * stride + where.offset));
            vertexNormals(positions, indices, reps).forEach((n, i)=>
                putFloats(data + i * stride + normal.offset, n));
            return method(thread, mesh, MESH.UnlockVertexBuffer, []);
        });
        return answer;
    };

    return {
        /**
         * HRESULT D3DXComputeNormals(LPD3DXBASEMESH pMesh, const DWORD *pAdjacency)
         *
         * The normal of every vertex of the mesh (vertexNormals), written into
         * the vertices in place. The mesh's declaration must have a position
         * and a normal, both of three floats; with an adjacency, vertices the
         * mesh says are one point share one normal.
         */
        D3DXComputeNormals: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([mesh, adjacency])=>{
                if ((mesh >>> 0) === 0 || !host.callGuest || !host.heap)
                {
                    return D3DERR_INVALIDCALL;
                }
                return computeNormals(mesh >>> 0, adjacency, host.currentThread?.());
            },
        },

        /**
         * HRESULT D3DXComputeBoundingBox(const D3DXVECTOR3 *pFirstPosition,
         *     DWORD NumVertices, DWORD dwStride, D3DXVECTOR3 *pMin, D3DXVECTOR3 *pMax)
         *
         * The first position starts both corners, so no vertices at all still
         * reads one: the documentation gives no other answer for an empty run.
         */
        D3DXComputeBoundingBox: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([first, count, stride, minOut, maxOut])=>{
                if ((first >>> 0) === 0 || (minOut >>> 0) === 0 || (maxOut >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                const low = position(first);
                const high = low.slice();
                for (let i = 1; i < (count >>> 0); i++)
                {
                    const p = position((first >>> 0) + i * (stride >>> 0));
                    for (let k = 0; k < 3; k++)
                    {
                        low[k] = Math.min(low[k], p[k]);
                        high[k] = Math.max(high[k], p[k]);
                    }
                }
                putFloats(minOut, low);
                putFloats(maxOut, high);
                return D3D_OK;
            },
        },

        /**
         * HRESULT D3DXComputeBoundingSphere(const D3DXVECTOR3 *pFirstPosition,
         *     DWORD NumVertices, DWORD dwStride, D3DXVECTOR3 *pCenter, FLOAT *pRadius)
         *
         * The centre is the mean of the positions, not the smallest enclosing
         * sphere's; the radius is the farthest position from it.
         */
        D3DXComputeBoundingSphere: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([first, count, stride, centerOut, radiusOut])=>{
                if ((first >>> 0) === 0 || (centerOut >>> 0) === 0 || (radiusOut >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                const n = count >>> 0;
                /** @param {number} i */
                const at = i=>(first >>> 0) + i * (stride >>> 0);
                const sum = [0, 0, 0];
                for (let i = 0; i < n; i++)
                {
                    const p = position(at(i));
                    for (let k = 0; k < 3; k++)
                    {
                        sum[k] = f(sum[k] + p[k]);
                    }
                }
                const center = sum.map(s=>f(s / n));
                let radius = 0;
                for (let i = 0; i < n; i++)
                {
                    const [dx, dy, dz] = position(at(i)).map((v, k)=>f(v - center[k]));
                    radius = Math.max(radius, f(Math.sqrt(f(f(f(dx * dx) + f(dy * dy))
                        + f(dz * dz)))));
                }
                putFloats(centerOut, center);
                putFloats(radiusOut, [radius]);
                return D3D_OK;
            },
        },
    };
}
