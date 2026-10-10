/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createDeviceCalls } from './device.js';
import { adjacencyFromPointReps, pointRepsFromPositions } from './mesh-topology.js';

/**
 * D3DX's shapes -- a box, a sphere, a cylinder, a torus and a regular
 * polygon -- as ID3DXMesh objects of mesh-object.js: D3DFVF_XYZ |
 * D3DFVF_NORMAL vertices, managed, one subset in the attribute table, and the
 * adjacency in an ID3DXBuffer when it is asked for.
 *
 * Each has the vertices and faces the documentation's description gives it,
 * centred on the origin: a box of four vertices a side; a sphere about the Z
 * axis, a pole at each end and stacks - 1 rings between; a cylinder along Z,
 * Radius1 at the negative end and Radius2 at the positive, a cap of its own
 * vertices at each end; a torus about the Z axis, its tube InnerRadius round
 * a ring OuterRadius from the centre; a polygon of sides of the given length
 * in the XY plane, facing +Z, round a centre vertex. The normals are the
 * shapes' own (a cylinder's sides slanting with the change of radius); every
 * face is wound clockwise seen from where its normal points, as Direct3D's
 * default culling keeps it. The order the vertices and faces come in is this
 * code's: a program that reads them back by number may find them elsewhere
 * than D3DX puts them.
 */

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const E_OUTOFMEMORY = 0x8007000e;
/** More vertices than this are more than a shape is made of here. */
const MOST_VERTICES = 1 << 24;
const D3DXMESH_32BIT = 0x1;
const D3DXMESH_MANAGED = 0x220;
const FVF = 0x12;
const STRIDE = 24;

/**
 * @typedef {Object} Shape
 * @property {number[][]} positions
 * @property {number[][]} normals
 * @property {number[]} indices  Three a face.
 */

/** @param {number[]} a @param {number[]} b */
const minus = (a, b)=>[a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {number[]} a @param {number[]} b */
const cross = (a, b)=>[a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]];
/** @param {number[]} a @param {number[]} b */
const dot = (a, b)=>a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {number[]} a */
const unit = a=>{
    const length = Math.hypot(a[0], a[1], a[2]);
    return length === 0 ? [0, 0, 0] : a.map(c=>c / length);
};

/**
 * The shape with every face turned to the side its corners' normals point
 * to: in Direct3D's left-handed space a face whose edges' cross product
 * points at the viewer is clockwise to it.
 *
 * @param {Shape} shape
 * @returns {Shape}
 */
function facingOut(shape){
    const { positions, normals, indices } = shape;
    for (let face = 0; face + 2 < indices.length; face += 3)
    {
        const [a, b, c] = indices.slice(face, face + 3);
        const turned = cross(minus(positions[b], positions[a]), minus(positions[c], positions[a]));
        const out = [0, 1, 2].map(k=>normals[a][k] + normals[b][k] + normals[c][k]);
        if (dot(turned, out) < 0)
        {
            indices[face + 1] = c;
            indices[face + 2] = b;
        }
    }
    return shape;
}

/**
 * A box: four vertices on each side, which has the side's normal, and two
 * faces.
 *
 * @param {number} width @param {number} height @param {number} depth
 * @returns {Shape}
 */
export function box(width, height, depth){
    const half = [width / 2, height / 2, depth / 2];
    /** @type {Shape} */
    const shape = { positions: [], normals: [], indices: [] };
    for (const axis of [0, 1, 2])
    {
        for (const sign of [-1, 1])
        {
            const normal = [0, 0, 0];
            normal[axis] = sign;
            const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
            const first = shape.positions.length;
            for (const [su, sv] of [[-1, -1], [-1, 1], [1, 1], [1, -1]])
            {
                const p = [0, 0, 0];
                p[axis] = sign * half[axis];
                p[u] = su * half[u];
                p[v] = sv * half[v];
                shape.positions.push(p);
                shape.normals.push(normal);
            }
            shape.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
        }
    }
    return facingOut(shape);
}

/**
 * Faces between two rings of `count` vertices each, closed round.
 *
 * @param {number[]} indices @param {number} a  The first ring's first vertex.
 * @param {number} b  The second's. @param {number} count
 */
function band(indices, a, b, count){
    for (let j = 0; j < count; j++)
    {
        const k = (j + 1) % count;
        indices.push(a + j, b + j, b + k, a + j, b + k, a + k);
    }
}

/**
 * Faces from one vertex to a ring of `count`, closed round.
 *
 * @param {number[]} indices @param {number} centre @param {number} ring @param {number} count
 */
function fan(indices, centre, ring, count){
    for (let j = 0; j < count; j++)
    {
        indices.push(centre, ring + j, ring + (j + 1) % count);
    }
}

/**
 * A sphere about the Z axis: a pole at +Z, stacks - 1 rings of `slices`
 * vertices, a pole at -Z.
 *
 * @param {number} radius @param {number} slices @param {number} stacks
 * @returns {Shape}
 */
export function sphere(radius, slices, stacks){
    /** @type {number[][]} */
    const normals = [[0, 0, 1]];
    for (let i = 1; i < stacks; i++)
    {
        const phi = Math.PI * i / stacks;
        for (let j = 0; j < slices; j++)
        {
            const theta = 2 * Math.PI * j / slices;
            normals.push([Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta),
                Math.cos(phi)]);
        }
    }
    normals.push([0, 0, -1]);
    /** @type {number[]} */
    const indices = [];
    fan(indices, 0, 1, slices);
    for (let i = 1; i < stacks - 1; i++)
    {
        band(indices, 1 + (i - 1) * slices, 1 + i * slices, slices);
    }
    fan(indices, normals.length - 1, 1 + (stacks - 2) * slices, slices);
    return facingOut({ positions: normals.map(n=>n.map(c=>c * radius)), normals, indices });
}

/**
 * A cylinder along Z from -length / 2 (radius1) to +length / 2 (radius2):
 * the -Z cap's centre and ring, stacks + 1 rings of the side, the +Z cap's
 * ring and centre.
 *
 * @param {number} radius1 @param {number} radius2 @param {number} length
 * @param {number} slices @param {number} stacks
 * @returns {Shape}
 */
export function cylinder(radius1, radius2, length, slices, stacks){
    /** @type {Shape} */
    const shape = { positions: [], normals: [], indices: [] };
    /** @param {number[]} p @param {number[]} n */
    const add = (p, n)=>{
        shape.positions.push(p);
        shape.normals.push(n);
    };
    /** @param {number} radius @param {number} z @param {(theta: number) => number[]} normal */
    const ring = (radius, z, normal)=>{
        for (let j = 0; j < slices; j++)
        {
            const theta = 2 * Math.PI * j / slices;
            add([radius * Math.cos(theta), radius * Math.sin(theta), z], normal(theta));
        }
    };
    const bottom = -length / 2;
    add([0, 0, bottom], [0, 0, -1]);
    ring(radius1, bottom, ()=>[0, 0, -1]);
    fan(shape.indices, 0, 1, slices);
    // The side's normal leans toward the narrower end by the slope of its radius.
    const lean = length === 0 ? 0 : (radius1 - radius2) / length;
    const side = 1 + slices;
    for (let i = 0; i <= stacks; i++)
    {
        ring(radius1 + (radius2 - radius1) * i / stacks, bottom + length * i / stacks,
            theta=>unit([Math.cos(theta), Math.sin(theta), lean]));
        if (i > 0)
        {
            band(shape.indices, side + (i - 1) * slices, side + i * slices, slices);
        }
    }
    const top = shape.positions.length;
    ring(radius2, -bottom, ()=>[0, 0, 1]);
    add([0, 0, -bottom], [0, 0, 1]);
    fan(shape.indices, top + slices, top, slices);
    return facingOut(shape);
}

/**
 * A torus about the Z axis: `rings` circles of the tube, each `sides`
 * vertices round, the tube `inner` thick about a circle `outer` from the
 * centre.
 *
 * @param {number} inner @param {number} outer @param {number} sides @param {number} rings
 * @returns {Shape}
 */
export function torus(inner, outer, sides, rings){
    /** @type {Shape} */
    const shape = { positions: [], normals: [], indices: [] };
    for (let i = 0; i < rings; i++)
    {
        const phi = 2 * Math.PI * i / rings;
        const out = [Math.cos(phi), Math.sin(phi), 0];
        for (let j = 0; j < sides; j++)
        {
            const theta = 2 * Math.PI * j / sides;
            const normal = [out[0] * Math.cos(theta), out[1] * Math.cos(theta),
                Math.sin(theta)];
            shape.normals.push(normal);
            shape.positions.push([0, 1, 2].map(k=>out[k] * outer + normal[k] * inner));
        }
        band(shape.indices, i * sides, ((i + 1) % rings) * sides, sides);
    }
    return facingOut(shape);
}

/**
 * A regular polygon in the XY plane, facing +Z: a centre vertex and one at
 * each corner, sides `length` long.
 *
 * @param {number} length @param {number} sides
 * @returns {Shape}
 */
export function polygon(length, sides){
    const radius = length / (2 * Math.sin(Math.PI / sides));
    /** @type {Shape} */
    const shape = { positions: [[0, 0, 0]], normals: [[0, 0, 1]], indices: [] };
    for (let j = 0; j < sides; j++)
    {
        const theta = 2 * Math.PI * j / sides;
        shape.positions.push([radius * Math.cos(theta), radius * Math.sin(theta), 0]);
        shape.normals.push([0, 0, 1]);
    }
    fan(shape.indices, 0, 1, sides);
    return facingOut(shape);
}

/** A FLOAT argument's value, from the dword the bridge reads. @param {number} bits */
const floatOf = bits=>new Float32Array(Uint32Array.of(bits >>> 0).buffer)[0];

/**
 * @param {import('./mesh-object.js').MeshHost} host
 * @param {ReturnType<typeof import('./mesh-object.js').createMeshObjects>} meshes
 * @param {{ giveBuffer: (out: number, bytes: Uint8Array) => number }} buffers
 */
export function createShapes(host, meshes, buffers){
    const { putU32s, method } = createDeviceCalls(host);

    /**
     * A shape made a mesh on the device, its adjacency given as a buffer
     * when asked for.
     *
     * @param {Shape} shape @param {number} device @param {number} out @param {number} adjacencyOut
     * @param {any} thread
     * @returns {Promise<number>}
     */
    const build = async(shape, device, out, adjacencyOut, thread)=>{
        const vertices = shape.positions.length;
        const faces = shape.indices.length / 3;
        const options = D3DXMESH_MANAGED | (vertices > 0xffff ? D3DXMESH_32BIT : 0);
        const elements = [{ stream: 0, offset: 0, type: 2, method: 0, usage: 0, usageIndex: 0 },
            { stream: 0, offset: 12, type: 2, method: 0, usage: 3, usageIndex: 0 }];
        const made = await meshes.make({ device, faces, vertices, options, elements, fvf: FVF },
            thread);
        if (made.answer !== D3D_OK)
        {
            return made.answer;
        }
        const bytes = new Uint8Array(vertices * STRIDE);
        const floats = new Float32Array(bytes.buffer);
        shape.positions.forEach((p, i)=>floats.set([...p, ...shape.normals[i]], i * 6));
        const written = await meshes.throughLock(thread, made.state.vb, bytes.length, bytes);
        let answer = typeof written === 'number' ? written
            : await meshes.writeIndices(made.state, shape.indices, thread);
        made.state.table = [{ id: 0, faceStart: 0, faceCount: faces, vertexStart: 0,
            vertexCount: vertices }];
        if (answer === D3D_OK && adjacencyOut !== 0)
        {
            const adjacency = adjacencyFromPointReps(shape.indices,
                pointRepsFromPositions(shape.positions, 0));
            answer = buffers.giveBuffer(adjacencyOut, new Uint8Array(
                Uint32Array.from(adjacency).buffer));
        }
        if (answer !== D3D_OK)
        {
            await method(thread, made.pointer, 2, []);
            return answer;
        }
        putU32s(out, [made.pointer]);
        return D3D_OK;
    };

    /**
     * A shape's export: its arguments after the device, the mesh and adjacency
     * out-pointers last; refused at once where the shape cannot be.
     *
     * @param {number} argBytes
     * @param {(args: number[]) => Shape | null} shapeOf  Its own arguments, raw; null for
     *     arguments that make no shape.
     * @param {(args: number[]) => number} count  The vertices they make.
     */
    const entry = (argBytes, shapeOf, count)=>({
        argBytes,
        /** @param {number[]} args */
        handler: args=>{
            const [device, ...rest] = args.map(a=>a >>> 0);
            const [out, adjacencyOut] = rest.slice(-2);
            for (const at of [out, adjacencyOut])
            {
                if (at !== 0)
                {
                    putU32s(at, [0]);
                }
            }
            if (device === 0 || out === 0 || !host.callGuest || !host.heap || !host.vtables)
            {
                return D3DERR_INVALIDCALL;
            }
            if (count(rest) > MOST_VERTICES)
            {
                return E_OUTOFMEMORY;
            }
            const shape = shapeOf(rest.slice(0, -2));
            if (!shape)
            {
                return D3DERR_INVALIDCALL;
            }
            const thread = host.currentThread?.();
            return Promise.resolve().then(()=>build(shape, device, out, adjacencyOut, thread));
        },
    });

    return {
        /**
         * HRESULT D3DXCreateBox(LPDIRECT3DDEVICE9 pDevice, FLOAT Width, FLOAT Height,
         *     FLOAT Depth, LPD3DXMESH *ppMesh, LPD3DXBUFFER *ppAdjacency)
         */
        D3DXCreateBox: entry(24, ([w, h, d])=>{
            const [width, height, depth] = [w, h, d].map(floatOf);
            return width >= 0 && height >= 0 && depth >= 0 ? box(width, height, depth) : null;
        }, ()=>24),
        /**
         * HRESULT D3DXCreateSphere(LPDIRECT3DDEVICE9 pDevice, FLOAT Radius, UINT Slices,
         *     UINT Stacks, LPD3DXMESH *ppMesh, LPD3DXBUFFER *ppAdjacency)
         */
        D3DXCreateSphere: entry(24, ([r, slices, stacks])=>{
            const radius = floatOf(r);
            return radius >= 0 && slices >= 2 && stacks >= 2 ? sphere(radius, slices, stacks)
                : null;
        }, ([, slices, stacks])=>slices * stacks),
        /**
         * HRESULT D3DXCreateCylinder(LPDIRECT3DDEVICE9 pDevice, FLOAT Radius1,
         *     FLOAT Radius2, FLOAT Length, UINT Slices, UINT Stacks, LPD3DXMESH *ppMesh,
         *     LPD3DXBUFFER *ppAdjacency)
         */
        D3DXCreateCylinder: entry(32, ([r1, r2, l, slices, stacks])=>{
            const [radius1, radius2, length] = [r1, r2, l].map(floatOf);
            return radius1 >= 0 && radius2 >= 0 && length >= 0 && slices >= 2 && stacks >= 1
                ? cylinder(radius1, radius2, length, slices, stacks) : null;
        }, ([, , , slices, stacks])=>slices * (stacks + 3)),
        /**
         * HRESULT D3DXCreateTorus(LPDIRECT3DDEVICE9 pDevice, FLOAT InnerRadius,
         *     FLOAT OuterRadius, UINT Sides, UINT Rings, LPD3DXMESH *ppMesh,
         *     LPD3DXBUFFER *ppAdjacency)
         */
        D3DXCreateTorus: entry(28, ([i, o, sides, rings])=>{
            const [inner, outer] = [i, o].map(floatOf);
            return inner >= 0 && outer >= 0 && sides >= 3 && rings >= 3
                ? torus(inner, outer, sides, rings) : null;
        }, ([, , sides, rings])=>sides * rings),
        /**
         * HRESULT D3DXCreatePolygon(LPDIRECT3DDEVICE9 pDevice, FLOAT Length, UINT Sides,
         *     LPD3DXMESH *ppMesh, LPD3DXBUFFER *ppAdjacency)
         */
        D3DXCreatePolygon: entry(20, ([l, sides])=>{
            const length = floatOf(l);
            return length >= 0 && sides >= 3 ? polygon(length, sides) : null;
        }, ([, sides])=>sides),
    };
}
