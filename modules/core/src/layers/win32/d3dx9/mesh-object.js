/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createComObject } from '../ole32/objects.js';
import { DEVICE, UNKNOWN_ADDREF, UNKNOWN_RELEASE, VERTEX_BUFFER, createDeviceCalls }
    from './device.js';
import { DECLTYPE, DECLUSAGE, MAX_FVF_DECL_SIZE, declarationBytes, declaratorFromFvf,
    declVertexSize, fvfFromDeclarator, readDeclaration, typeBytes } from './fvf.js';
import { NO_FACE, adjacencyFromPointReps, attributeOrder, attributeTable,
    pointRepsFromAdjacency, pointRepsFromPositions } from './mesh-topology.js';
import { indexBufferOf } from './mesh.js';

/**
 * ID3DXMesh, D3DX's own: a vertex buffer and an index buffer made on the
 * program's device with its own CreateVertexBuffer and CreateIndexBuffer,
 * a vertex declaration made with CreateVertexDeclaration, and an attribute
 * buffer -- a DWORD a face -- in guest memory, with the attribute table
 * that names each subset's faces and vertices.
 *
 * Its vtable is ID3DXBaseMesh's and then ID3DXMesh's, in d3dx9mesh.h's order,
 * so what reaches a program's own mesh through its vtable (mesh.js) reaches
 * this one the same way. The buffers are locked through their own Lock and
 * Unlock; DrawSubset sets the declaration, stream 0 and the indices and
 * draws each range of the subset with DrawIndexedPrimitive -- the attribute
 * table's ranges, or, before there is a table, each run of faces the
 * attribute buffer gives the subset.
 *
 * OptimizeInplace sorts the faces by attribute (ATTRSORT, which VERTEXCACHE
 * and STRIPREORDER do too: neither reorders for a cache here) and, unless
 * IGNOREVERTS, the vertices in the order the sorted faces first use them,
 * the ones no face uses dropped for COMPACT; it then builds the attribute
 * table. Cloning converts each element the two declarations share by usage
 * and index: the same type copied, floats to more or fewer floats (a fourth
 * component 1, the others 0) and colours to and from four floats.
 */

export const IID_ID3DXBASEMESH = '{7ED943DD-52E8-40B5-A8D8-76685C406330}';
export const IID_ID3DXMESH = '{4020E5C2-1403-4929-883F-E2E849FAC195}';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const E_OUTOFMEMORY = 0x8007000e;
const D3DLOCK_READONLY = 0x10;
const D3DPT_TRIANGLELIST = 4;
const D3DXMESH_32BIT = 0x1;

/** D3DXMESHOPT flags, and those of them that are no D3DXMESH option. */
const MESHOPT = Object.freeze({ COMPACT: 0x01000000, ATTRSORT: 0x02000000,
    VERTEXCACHE: 0x04000000, STRIPREORDER: 0x08000000, IGNOREVERTS: 0x10000000 });
const MESHOPT_BITS = 0x3f400000;

/**
 * The vertex buffer's usage and pool from D3DXMESH options: each VB_ option
 * (and those for both buffers) as the D3DUSAGE it stands for, and the pool.
 *
 * @param {number} options
 */
export function vertexBufferOf(options){
    /** @type {[number, number][]} */
    const usages = [[0x2, 0x20], [0x4, 0x40], [0x8, 0x80], [0x4000, 0x100], [0x40, 0x8],
        [0x80, 0x200], [0x8000, 0x10]];
    const usage = usages.reduce((sum, [option, use])=>(options & option ? sum | use : sum), 0);
    const pool = options & 0x10 ? 2 : options & 0x20 ? 1 : 0;
    return { usage, pool };
}

/**
 * One vertex's elements in another declaration's layout: each element of
 * `to` from the element of `from` with the same usage and index.
 *
 * @param {import('./fvf.js').VertexElement[]} from @param {import('./fvf.js').VertexElement[]} to
 * @returns {(source: DataView, target: DataView) => void}  Over one vertex each.
 */
export function vertexConverter(from, to){
    const floats = (/** @type {number} */ type)=>(type <= DECLTYPE.FLOAT4 ? type + 1 : 0);
    /** @type {((source: DataView, target: DataView) => void)[]} */
    const steps = [];
    for (const out of to.filter(e=>e.stream === 0))
    {
        const given = from.find(e=>e.stream === 0 && e.usage === out.usage
            && e.usageIndex === out.usageIndex);
        if (!given)
        {
            continue;
        }
        const [a, b] = [given.offset, out.offset];
        if (given.type === out.type)
        {
            const length = typeBytes(out.type);
            steps.push((source, target)=>{
                for (let k = 0; k < length; k++)
                {
                    target.setUint8(b + k, source.getUint8(a + k));
                }
            });
        }
        else if (floats(given.type) && floats(out.type))
        {
            const [have, want] = [floats(given.type), floats(out.type)];
            steps.push((source, target)=>{
                for (let k = 0; k < want; k++)
                {
                    target.setFloat32(b + k * 4, k < have ? source.getFloat32(a + k * 4, true)
                        : k === 3 ? 1 : 0, true);
                }
            });
        }
        else if (given.type === DECLTYPE.D3DCOLOR && out.type === DECLTYPE.FLOAT4)
        {
            // D3DCOLOR is B, G, R, A in memory; the floats are R, G, B, A.
            steps.push((source, target)=>[2, 1, 0, 3].forEach((byte, k)=>
                target.setFloat32(b + k * 4, source.getUint8(a + byte) / 255, true)));
        }
        else if (given.type === DECLTYPE.FLOAT4 && out.type === DECLTYPE.D3DCOLOR)
        {
            steps.push((source, target)=>[2, 1, 0, 3].forEach((byte, k)=>
                target.setUint8(b + byte, Math.round(Math.min(1, Math.max(0,
                    source.getFloat32(a + k * 4, true))) * 255))));
        }
    }
    return (source, target)=>steps.forEach(step=>step(source, target));
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
 * @property {{ publish: (object: any, interfaceId: string) => number }} [vtables]
 */

/**
 * What a mesh is made of.
 *
 * @typedef {Object} MeshSpec
 * @property {number} device
 * @property {number} faces
 * @property {number} vertices
 * @property {number} options
 * @property {import('./fvf.js').VertexElement[]} elements
 * @property {number} fvf  0 for a declaration no FVF lays out.
 */

/**
 * @param {MeshHost} host
 * @param {{ giveBuffer: (out: number, bytes: Uint8Array) => number }} buffers
 */
export function createMeshObjects(host, buffers){
    const { u32, putU32s, method } = createDeviceCalls(host);
    const heap = ()=>/** @type {NonNullable<MeshHost['heap']>} */ (host.heap);
    /** Meshes by the interface pointer a program holds. @type {Map<number, any>} */
    const byPointer = new Map();

    /**
     * Scratch memory for a call's out-values, given back however the work ends.
     *
     * @template T
     * @param {number} bytes @param {(at: number) => Promise<T>} work
     * @returns {Promise<T | number>}
     */
    const withScratch = async(bytes, work)=>{
        const at = heap().allocate(bytes);
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
            heap().free(at);
        }
    };

    /** @param {any} state */
    const indexBytes = state=>(state.options & D3DXMESH_32BIT ? 4 : 2);

    /**
     * A buffer's bytes, read or written whole through its Lock.
     *
     * @param {any} thread @param {number} buffer @param {number} length
     * @param {Uint8Array | null} bytes  What to write, or null to read.
     * @returns {Promise<Uint8Array | number>}
     */
    const throughLock = (thread, buffer, length, bytes)=>withScratch(4, async at=>{
        putU32s(at, [0]);
        const locked = await method(thread, buffer, VERTEX_BUFFER.Lock, [0, 0, at,
            bytes ? 0 : D3DLOCK_READONLY]);
        if (locked !== D3D_OK)
        {
            return locked;
        }
        let read = bytes;
        if (bytes)
        {
            host.writeMemory(u32(at), bytes);
        }
        else
        {
            read = host.readMemory(u32(at), length).slice();
        }
        await method(thread, buffer, VERTEX_BUFFER.Unlock, []);
        return /** @type {Uint8Array} */ (read);
    });

    /** @param {any} state @param {any} thread @returns {Promise<number[] | number>} */
    const readIndices = async(state, thread)=>{
        const bytes = await throughLock(thread, state.ib, state.faces * 3 * indexBytes(state),
            null);
        if (typeof bytes === 'number')
        {
            return bytes;
        }
        return [...(indexBytes(state) === 4 ? new Uint32Array(bytes.buffer)
            : new Uint16Array(bytes.buffer))];
    };

    /** @param {any} state @param {number[]} indices @param {any} thread */
    const writeIndices = async(state, indices, thread)=>{
        const bytes = new Uint8Array((indexBytes(state) === 4 ? Uint32Array.from(indices)
            : Uint16Array.from(indices)).buffer);
        const written = await throughLock(thread, state.ib, bytes.length, bytes);
        return typeof written === 'number' ? written : D3D_OK;
    };

    /** @param {any} state @param {any} thread @returns {Promise<Uint8Array | number>} */
    const readVertices = (state, thread)=>throughLock(thread, state.vb,
        state.vertices * state.stride, null);

    /** @param {any} state */
    const attributesOf = state=>[...new Uint32Array(host.readMemory(state.attributes,
        state.faces * 4).slice().buffer)];

    /**
     * Each vertex's position, as the declaration places it.
     *
     * @param {any} state @param {Uint8Array} bytes
     * @returns {number[][] | null}
     */
    const positionsOf = (state, bytes)=>{
        const element = state.elements.find((/** @type {any} */ e)=>e.stream === 0
            && e.usageIndex === 0 && (e.usage === DECLUSAGE.POSITION
                || e.usage === DECLUSAGE.POSITIONT));
        if (!element || element.type < DECLTYPE.FLOAT3 || element.type > DECLTYPE.FLOAT4)
        {
            return null;
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return Array.from({ length: state.vertices }, (_, i)=>[0, 1, 2].map(k=>
            view.getFloat32(i * state.stride + element.offset + k * 4, true)));
    };

    /** An adjacency's DWORDs, three a face. @param {any} state @param {number} at */
    const adjacencyAt = (state, at)=>[...new Uint32Array(host.readMemory(at >>> 0,
        state.faces * 12).slice().buffer)];

    /** @param {number} at @param {number[]} values */
    const putAll = (at, values)=>host.writeMemory(at >>> 0,
        new Uint8Array(Uint32Array.from(values).buffer));

    /**
     * A mesh made on a device: its buffers, its declaration, its attribute
     * buffer zeroed, and the object published.
     *
     * @param {MeshSpec} spec @param {any} thread
     * @returns {Promise<{ answer: number, pointer: number, state: any }>}
     */
    const make = async(spec, thread)=>{
        /** @param {number} answer */
        const failed = answer=>({ answer, pointer: 0, state: null });
        const stride = declVertexSize(spec.elements, 0);
        const wide = (spec.options & D3DXMESH_32BIT) !== 0;
        /** @type {number[]} */
        const made = [];
        const declaration = declarationBytes(spec.elements);
        const answer = await withScratch(8 + declaration.length, async at=>{
            putU32s(at, [0, 0]);
            const vb = vertexBufferOf(spec.options);
            const ib = indexBufferOf(spec.options);
            let result = await method(thread, spec.device, DEVICE.CreateVertexBuffer,
                [spec.vertices * stride, vb.usage, spec.fvf, vb.pool, at, 0]);
            if (result !== D3D_OK)
            {
                return result;
            }
            made.push(u32(at));
            result = await method(thread, spec.device, DEVICE.CreateIndexBuffer,
                [spec.faces * 3 * (wide ? 4 : 2), ib.usage, ib.format, ib.pool, at + 4, 0]);
            if (result !== D3D_OK)
            {
                return result;
            }
            made.push(u32(at + 4));
            host.writeMemory(at + 8, declaration);
            putU32s(at, [0]);
            result = await method(thread, spec.device, DEVICE.CreateVertexDeclaration,
                [at + 8, at]);
            if (result !== D3D_OK)
            {
                return result;
            }
            made.push(u32(at));
            return D3D_OK;
        });
        const release = async()=>{
            for (const object of made)
            {
                await method(thread, object, UNKNOWN_RELEASE, []);
            }
        };
        if (answer !== D3D_OK)
        {
            await release();
            return failed(answer);
        }
        const attributes = heap().allocate(spec.faces * 4);
        if (attributes === 0)
        {
            await release();
            return failed(E_OUTOFMEMORY);
        }
        host.writeMemory(attributes, new Uint8Array(spec.faces * 4));
        await method(thread, spec.device, UNKNOWN_ADDREF, []);
        const [vb, ib, declared] = made;
        const state = { device: spec.device, options: spec.options, fvf: spec.fvf,
            elements: spec.elements, stride, faces: spec.faces, vertices: spec.vertices, vb, ib,
            declared, attributes, /** @type {import('./mesh-topology.js').AttributeRange[]} */
            table: [], pointer: 0 };
        const object = publish(state);
        if (!object)
        {
            await letGo(state, thread);
            return failed(E_OUTOFMEMORY);
        }
        return { answer: D3D_OK, pointer: state.pointer, state };
    };

    /**
     * The mesh object, published; null when it could not be.
     *
     * @param {any} state
     */
    const publish = state=>{
        const object = createComObject(IID_ID3DXMESH, { interfaces: [baseMesh, mesh], state,
            // Run inside the dispatch of the Release that ends the mesh, before it
            // awaits anything: the thread asked for is that Release's caller.
            lastRelease: ()=>letGo(state, host.currentThread?.()),
            destroy: ()=>{
                byPointer.delete(state.pointer);
                heap().free(state.attributes);
            } });
        state.pointer = /** @type {NonNullable<MeshHost['vtables']>} */ (host.vtables)
            .publish(object, IID_ID3DXMESH) >>> 0;
        if (state.pointer === 0)
        {
            object.release();
            return null;
        }
        byPointer.set(state.pointer, object);
        return object;
    };

    /**
     * What a mesh holds on the device, let go as its last reference goes.
     *
     * @param {any} state @param {any} thread
     */
    const letGo = async(state, thread)=>{
        await null;
        for (const object of [state.vb, state.ib, state.declared, state.device])
        {
            await method(thread, object, UNKNOWN_RELEASE, []);
        }
    };

    /**
     * A method whose work calls into the guest: run once its invoke has
     * returned, on the thread whose call it answers.
     *
     * @param {string} name @param {number} argBytes
     * @param {(state: any, args: number[], thread: any) => Promise<number>} work
     * @param {(state: any, args: number[]) => boolean} [refused]  Checked first, at once.
     * @returns {import('../ole32/objects.js').ComMethod}
     */
    const later = (name, argBytes, work, refused)=>({ name, argBytes,
        invoke: (object, args)=>{
            if (refused?.(object.state, args))
            {
                return D3DERR_INVALIDCALL;
            }
            const thread = host.currentThread?.();
            return Promise.resolve().then(()=>work(object.state, args, thread));
        } });

    /**
     * Faces with one attribute, as ranges to draw: the attribute table's, or
     * the attribute buffer's runs before there is a table.
     *
     * @param {any} state @param {number} id
     */
    const rangesOf = (state, id)=>{
        if (state.table.length > 0)
        {
            return state.table.filter((/** @type {any} */ range)=>range.id === id);
        }
        const attributes = attributesOf(state);
        /** @type {import('./mesh-topology.js').AttributeRange[]} */
        const ranges = [];
        for (let face = 0; face < state.faces; face++)
        {
            if (attributes[face] !== id)
            {
                continue;
            }
            const last = ranges.at(-1);
            if (last && last.faceStart + last.faceCount === face)
            {
                last.faceCount++;
            }
            else
            {
                ranges.push({ id, faceStart: face, faceCount: 1, vertexStart: 0,
                    vertexCount: state.vertices });
            }
        }
        return ranges;
    };

    /**
     * A copy of a mesh in another declaration, on a device, with its own
     * options: the vertices converted, the indices, attributes and attribute
     * table as they are.
     *
     * @param {any} state @param {number} options
     * @param {import('./fvf.js').VertexElement[]} elements @param {number} fvf
     * @param {number} device @param {number} out @param {any} thread
     * @returns {Promise<number>}
     */
    const clone = async(state, options, elements, fvf, device, out, thread)=>{
        const indices = await readIndices(state, thread);
        if (typeof indices === 'number')
        {
            return indices;
        }
        if (!(options & D3DXMESH_32BIT) && indices.some(index=>index > 0xffff))
        {
            return D3DERR_INVALIDCALL;
        }
        const vertices = await readVertices(state, thread);
        if (typeof vertices === 'number')
        {
            return vertices;
        }
        const made = await make({ device, faces: state.faces, vertices: state.vertices, options,
            elements, fvf }, thread);
        if (made.answer !== D3D_OK)
        {
            return made.answer;
        }
        const copy = made.state;
        const converted = new Uint8Array(copy.vertices * copy.stride);
        const convert = vertexConverter(state.elements, elements);
        for (let i = 0; i < state.vertices; i++)
        {
            convert(new DataView(vertices.buffer, i * state.stride, state.stride),
                new DataView(converted.buffer, i * copy.stride, copy.stride));
        }
        const written = await throughLock(thread, copy.vb, converted.length, converted);
        const answer = typeof written === 'number' ? written
            : await writeIndices(copy, indices, thread);
        if (answer !== D3D_OK)
        {
            await method(thread, made.pointer, UNKNOWN_RELEASE, []);
            return answer;
        }
        host.writeMemory(copy.attributes, host.readMemory(state.attributes, state.faces * 4)
            .slice());
        copy.table = state.table.map((/** @type {any} */ range)=>({ ...range }));
        putU32s(out, [made.pointer]);
        return D3D_OK;
    };

    /**
     * OptimizeInplace's work.
     *
     * @param {any} state @param {number[]} args @param {any} thread
     * @returns {Promise<number>}
     */
    const optimize = async(state, args, thread)=>{
        const [flags, adjacencyIn, adjacencyOut, faceRemap, vertexRemap] = args;
        const indices = await readIndices(state, thread);
        if (typeof indices === 'number')
        {
            return indices;
        }
        const attributes = attributesOf(state);
        const sorts = (flags & (MESHOPT.ATTRSORT | MESHOPT.VERTEXCACHE | MESHOPT.STRIPREORDER))
            !== 0;
        const order = sorts ? attributeOrder(attributes)
            : attributes.map((_, i)=>i);
        const faceIndices = order.flatMap(face=>indices.slice(face * 3, face * 3 + 3));
        // The new vertices as old ones: first used first, unless only the faces move.
        /** @type {number[]} */
        let kept = Array.from({ length: state.vertices }, (_, i)=>i);
        if (!(flags & MESHOPT.IGNOREVERTS))
        {
            const seen = new Set(faceIndices);
            const used = [...new Set(faceIndices)];
            kept = flags & MESHOPT.COMPACT ? used
                : used.concat(kept.filter(vertex=>!seen.has(vertex)));
        }
        const newOf = new Map(kept.map((old, i)=>[old, i]));
        const newIndices = faceIndices.map(index=>/** @type {number} */ (newOf.get(index)));
        /** @type {number[] | null} */
        let adjacency = null;
        if ((adjacencyOut >>> 0) !== 0)
        {
            let given = (adjacencyIn >>> 0) !== 0 ? adjacencyAt(state, adjacencyIn) : null;
            if (!given)
            {
                const bytes = await readVertices(state, thread);
                const positions = typeof bytes === 'number' ? null : positionsOf(state, bytes);
                if (!positions)
                {
                    return typeof bytes === 'number' ? bytes : D3DERR_INVALIDCALL;
                }
                given = adjacencyFromPointReps(indices, pointRepsFromPositions(positions, 0));
            }
            const faceOf = new Map(order.map((old, i)=>[old, i]));
            const from = /** @type {number[]} */ (given);
            adjacency = order.flatMap(old=>[0, 1, 2].map(edge=>{
                const other = from[old * 3 + edge];
                return other === NO_FACE ? NO_FACE : faceOf.get(other) ?? NO_FACE;
            }));
        }
        if (kept.some((old, i)=>old !== i) || kept.length !== state.vertices)
        {
            const bytes = await readVertices(state, thread);
            if (typeof bytes === 'number')
            {
                return bytes;
            }
            const moved = new Uint8Array(state.vertices * state.stride);
            kept.forEach((old, i)=>moved.set(bytes.subarray(old * state.stride,
                (old + 1) * state.stride), i * state.stride));
            const written = await throughLock(thread, state.vb, moved.length, moved);
            if (typeof written === 'number')
            {
                return written;
            }
            state.vertices = kept.length;
        }
        const answer = await writeIndices(state, newIndices, thread);
        if (answer !== D3D_OK)
        {
            return answer;
        }
        const sorted = order.map(face=>attributes[face]);
        putAll(state.attributes, sorted);
        if (sorts)
        {
            state.table = attributeTable(sorted, newIndices);
        }
        if (adjacency)
        {
            putAll(adjacencyOut, adjacency);
        }
        if ((faceRemap >>> 0) !== 0)
        {
            putAll(faceRemap, order);
        }
        if ((vertexRemap >>> 0) !== 0)
        {
            return buffers.giveBuffer(vertexRemap >>> 0, new Uint8Array(
                Uint32Array.from(kept).buffer));
        }
        return D3D_OK;
    };

    /** @param {number} flags */
    const badFlags = flags=>(flags & (MESHOPT.COMPACT | MESHOPT.ATTRSORT | MESHOPT.VERTEXCACHE
        | MESHOPT.STRIPREORDER)) === 0 || (flags & (MESHOPT.VERTEXCACHE | MESHOPT.STRIPREORDER))
        === (MESHOPT.VERTEXCACHE | MESHOPT.STRIPREORDER);

    /** ID3DXBaseMesh's methods, after IUnknown's, in order. @type {import('../ole32/objects.js').ComMethod[]} */
    const BASE_METHODS = [
        /** HRESULT DrawSubset(DWORD AttribId) */
        later('DrawSubset', 8, async(state, [id], thread)=>{
            const ranges = rangesOf(state, id >>> 0);
            if (ranges.length === 0)
            {
                return D3D_OK;
            }
            await method(thread, state.device, DEVICE.SetVertexDeclaration, [state.declared]);
            await method(thread, state.device, DEVICE.SetStreamSource, [0, state.vb, 0,
                state.stride]);
            await method(thread, state.device, DEVICE.SetIndices, [state.ib]);
            for (const range of ranges)
            {
                const drawn = await method(thread, state.device, DEVICE.DrawIndexedPrimitive,
                    [D3DPT_TRIANGLELIST, 0, range.vertexStart, range.vertexCount,
                        range.faceStart * 3, range.faceCount]);
                if (drawn !== D3D_OK)
                {
                    return drawn;
                }
            }
            return D3D_OK;
        }),
        /** DWORD GetNumFaces() */
        { name: 'GetNumFaces', argBytes: 4, invoke: object=>object.state.faces },
        /** DWORD GetNumVertices() */
        { name: 'GetNumVertices', argBytes: 4, invoke: object=>object.state.vertices },
        /** DWORD GetFVF() */
        { name: 'GetFVF', argBytes: 4, invoke: object=>object.state.fvf },
        /** HRESULT GetDeclaration(D3DVERTEXELEMENT9 Declaration[MAX_FVF_DECL_SIZE]) */
        { name: 'GetDeclaration', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            host.writeMemory(out >>> 0, declarationBytes(object.state.elements));
            return D3D_OK;
        } },
        /** DWORD GetNumBytesPerVertex() */
        { name: 'GetNumBytesPerVertex', argBytes: 4, invoke: object=>object.state.stride },
        /** DWORD GetOptions() */
        { name: 'GetOptions', argBytes: 4, invoke: object=>object.state.options },
        /** HRESULT GetDevice(LPDIRECT3DDEVICE9 *ppDevice) -- a reference the caller releases. */
        later('GetDevice', 8, async(state, [out], thread)=>{
            await method(thread, state.device, UNKNOWN_ADDREF, []);
            putU32s(out, [state.device]);
            return D3D_OK;
        }, (_, [out])=>(out >>> 0) === 0),
        /**
         * HRESULT CloneMeshFVF(DWORD Options, DWORD FVF, LPDIRECT3DDEVICE9 pD3DDevice,
         *     LPD3DXMESH *ppCloneMesh)
         */
        later('CloneMeshFVF', 20, (state, [options, fvf, device, out], thread)=>clone(state,
            options >>> 0, /** @type {any} */ (declaratorFromFvf(fvf >>> 0)), fvf >>> 0,
            device >>> 0, out >>> 0, thread), (_, [, fvf, device, out])=>{
            if ((out >>> 0) !== 0)
            {
                putU32s(out, [0]);
            }
            return (out >>> 0) === 0 || (device >>> 0) === 0 || !declaratorFromFvf(fvf >>> 0);
        }),
        /**
         * HRESULT CloneMesh(DWORD Options, const D3DVERTEXELEMENT9 *pDeclaration,
         *     LPDIRECT3DDEVICE9 pD3DDevice, LPD3DXMESH *ppCloneMesh)
         */
        later('CloneMesh', 20, (state, [options, declaration, device, out], thread)=>{
            const elements = /** @type {any} */ (readDeclaration(host.readMemory, declaration));
            return clone(state, options >>> 0, elements, fvfFromDeclarator(elements) ?? 0,
                device >>> 0, out >>> 0, thread);
        }, (_, [, declaration, device, out])=>{
            if ((out >>> 0) !== 0)
            {
                putU32s(out, [0]);
            }
            return (out >>> 0) === 0 || (device >>> 0) === 0 || (declaration >>> 0) === 0
                || !readDeclaration(host.readMemory, declaration);
        }),
        /** HRESULT GetVertexBuffer(LPDIRECT3DVERTEXBUFFER9 *ppVB) */
        later('GetVertexBuffer', 8, async(state, [out], thread)=>{
            await method(thread, state.vb, UNKNOWN_ADDREF, []);
            putU32s(out, [state.vb]);
            return D3D_OK;
        }, (_, [out])=>(out >>> 0) === 0),
        /** HRESULT GetIndexBuffer(LPDIRECT3DINDEXBUFFER9 *ppIB) */
        later('GetIndexBuffer', 8, async(state, [out], thread)=>{
            await method(thread, state.ib, UNKNOWN_ADDREF, []);
            putU32s(out, [state.ib]);
            return D3D_OK;
        }, (_, [out])=>(out >>> 0) === 0),
        /** HRESULT LockVertexBuffer(DWORD Flags, LPVOID *ppData) */
        later('LockVertexBuffer', 12, (state, [flags, out], thread)=>method(thread, state.vb,
            VERTEX_BUFFER.Lock, [0, 0, out >>> 0, flags >>> 0]), (_, [, out])=>(out >>> 0) === 0),
        /** HRESULT UnlockVertexBuffer() */
        later('UnlockVertexBuffer', 4, (state, _, thread)=>method(thread, state.vb,
            VERTEX_BUFFER.Unlock, [])),
        /** HRESULT LockIndexBuffer(DWORD Flags, LPVOID *ppData) */
        later('LockIndexBuffer', 12, (state, [flags, out], thread)=>method(thread, state.ib,
            VERTEX_BUFFER.Lock, [0, 0, out >>> 0, flags >>> 0]), (_, [, out])=>(out >>> 0) === 0),
        /** HRESULT UnlockIndexBuffer() */
        later('UnlockIndexBuffer', 4, (state, _, thread)=>method(thread, state.ib,
            VERTEX_BUFFER.Unlock, [])),
        /**
         * HRESULT GetAttributeTable(D3DXATTRIBUTERANGE *pAttribTable,
         *     DWORD *pAttribTableSize)
         */
        { name: 'GetAttributeTable', argBytes: 12, invoke: (object, [table, size])=>{
            const ranges = object.state.table;
            if ((table >>> 0) !== 0)
            {
                putAll(table, ranges.flatMap((/** @type {any} */ r)=>[r.id, r.faceStart,
                    r.faceCount, r.vertexStart, r.vertexCount]));
            }
            if ((size >>> 0) !== 0)
            {
                putU32s(size, [ranges.length]);
            }
            return D3D_OK;
        } },
        /** HRESULT ConvertPointRepsToAdjacency(const DWORD *pPRep, DWORD *pAdjacency) */
        later('ConvertPointRepsToAdjacency', 12, async(state, [reps, out], thread)=>{
            const indices = await readIndices(state, thread);
            if (typeof indices === 'number')
            {
                return indices;
            }
            const given = (reps >>> 0) === 0 ? Array.from({ length: state.vertices }, (_, i)=>i)
                : [...new Uint32Array(host.readMemory(reps >>> 0, state.vertices * 4).slice()
                    .buffer)];
            putAll(out, adjacencyFromPointReps(indices, given));
            return D3D_OK;
        }, (_, [, out])=>(out >>> 0) === 0),
        /** HRESULT ConvertAdjacencyToPointReps(const DWORD *pAdjacency, DWORD *pPRep) */
        later('ConvertAdjacencyToPointReps', 12, async(state, [adjacency, out], thread)=>{
            const indices = await readIndices(state, thread);
            if (typeof indices === 'number')
            {
                return indices;
            }
            putAll(out, pointRepsFromAdjacency(indices, adjacencyAt(state, adjacency),
                state.vertices));
            return D3D_OK;
        }, (_, [adjacency, out])=>(adjacency >>> 0) === 0 || (out >>> 0) === 0),
        /** HRESULT GenerateAdjacency(FLOAT Epsilon, DWORD *pAdjacency) */
        later('GenerateAdjacency', 12, async(state, [epsilon, out], thread)=>{
            const indices = await readIndices(state, thread);
            const bytes = await readVertices(state, thread);
            if (typeof indices === 'number' || typeof bytes === 'number')
            {
                return typeof indices === 'number' ? indices : /** @type {number} */ (bytes);
            }
            const positions = positionsOf(state, bytes);
            if (!positions)
            {
                return D3DERR_INVALIDCALL;
            }
            const within = new Float32Array(Uint32Array.of(epsilon >>> 0).buffer)[0];
            putAll(out, adjacencyFromPointReps(indices, pointRepsFromPositions(positions,
                within)));
            return D3D_OK;
        }, (_, [epsilon, out])=>(out >>> 0) === 0
            || !(new Float32Array(Uint32Array.of(epsilon >>> 0).buffer)[0] >= 0)),
        /**
         * HRESULT UpdateSemantics(D3DVERTEXELEMENT9 Declaration[MAX_FVF_DECL_SIZE]) --
         * the same vertices read another way: a declaration wider than they are is
         * refused.
         */
        later('UpdateSemantics', 8, async(state, [declaration], thread)=>{
            const elements = /** @type {any} */ (readDeclaration(host.readMemory, declaration));
            const made = await withScratch(4 + MAX_FVF_DECL_SIZE * 8, async at=>{
                host.writeMemory(at + 4, declarationBytes(elements));
                const answer = await method(thread, state.device, DEVICE.CreateVertexDeclaration,
                    [at + 4, at]);
                return answer === D3D_OK ? { declared: u32(at) } : answer;
            });
            if (typeof made === 'number')
            {
                return made;
            }
            await method(thread, state.declared, UNKNOWN_RELEASE, []);
            state.declared = made.declared;
            state.elements = elements;
            state.fvf = fvfFromDeclarator(elements) ?? 0;
            return D3D_OK;
        }, (state, [declaration])=>{
            const elements = (declaration >>> 0) === 0 ? null
                : readDeclaration(host.readMemory, declaration);
            return !elements || declVertexSize(elements, 0) > state.stride;
        }),
    ];

    /** ID3DXMesh's own methods, after the base mesh's. @type {import('../ole32/objects.js').ComMethod[]} */
    const MESH_METHODS = [
        /** HRESULT LockAttributeBuffer(DWORD Flags, DWORD **ppData) */
        { name: 'LockAttributeBuffer', argBytes: 12, invoke: (object, [, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            putU32s(out, [object.state.attributes]);
            return D3D_OK;
        } },
        /** HRESULT UnlockAttributeBuffer() */
        { name: 'UnlockAttributeBuffer', argBytes: 4, invoke: ()=>D3D_OK },
        /**
         * HRESULT Optimize(DWORD Flags, const DWORD *pAdjacencyIn, DWORD *pAdjacencyOut,
         *     DWORD *pFaceRemap, LPD3DXBUFFER *ppVertexRemap, LPD3DXMESH *ppOptMesh)
         *
         * A clone with the options among the flags, then OptimizeInplace on it.
         */
        later('Optimize', 28, async(state, args, thread)=>{
            const [flags, adjacencyIn, adjacencyOut, faceRemap, vertexRemap, out] = args;
            const answer = await clone(state, flags & ~MESHOPT_BITS, state.elements, state.fvf,
                state.device, out >>> 0, thread);
            if (answer !== D3D_OK)
            {
                return answer;
            }
            const copy = byPointer.get(u32(out)).state;
            const optimized = await optimize(copy, [flags, adjacencyIn, adjacencyOut, faceRemap,
                vertexRemap], thread);
            if (optimized !== D3D_OK)
            {
                await method(thread, copy.pointer, UNKNOWN_RELEASE, []);
                putU32s(out, [0]);
            }
            return optimized;
        }, (_, [flags, , , , vertexRemap, out])=>{
            for (const at of [vertexRemap, out])
            {
                if ((at >>> 0) !== 0)
                {
                    putU32s(at, [0]);
                }
            }
            return (out >>> 0) === 0 || badFlags(flags);
        }),
        /**
         * HRESULT OptimizeInplace(DWORD Flags, const DWORD *pAdjacencyIn,
         *     DWORD *pAdjacencyOut, DWORD *pFaceRemap, LPD3DXBUFFER *ppVertexRemap)
         *
         * A flag set with none of COMPACT, ATTRSORT, VERTEXCACHE and
         * STRIPREORDER, or both of the last two, is refused.
         */
        later('OptimizeInplace', 24, (state, args, thread)=>optimize(state, args, thread),
            (_, [flags, , , , vertexRemap])=>{
                if ((vertexRemap >>> 0) !== 0)
                {
                    putU32s(vertexRemap, [0]);
                }
                return badFlags(flags);
            }),
        /** HRESULT SetAttributeTable(const D3DXATTRIBUTERANGE *pAttribTable, DWORD cAttribTableSize) */
        { name: 'SetAttributeTable', argBytes: 12, invoke: (object, [table, size])=>{
            const count = size >>> 0;
            if ((table >>> 0) === 0 && count > 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const words = count === 0 ? [] : [...new Uint32Array(host.readMemory(table >>> 0,
                count * 20).slice().buffer)];
            object.state.table = Array.from({ length: count }, (_, i)=>{
                const [id, faceStart, faceCount, vertexStart, vertexCount]
                    = words.slice(i * 5, i * 5 + 5);
                return { id, faceStart, faceCount, vertexStart, vertexCount };
            });
            return D3D_OK;
        } },
    ];

    /** @type {import('../ole32/objects.js').ComInterfaceDescriptor} */
    const baseMesh = { id: IID_ID3DXBASEMESH, methods: BASE_METHODS };
    /** @type {import('../ole32/objects.js').ComInterfaceDescriptor} */
    const mesh = { id: IID_ID3DXMESH, methods: [...BASE_METHODS, ...MESH_METHODS] };

    /**
     * D3DXCreateMesh and D3DXCreateMeshFVF's work: checked at once, made once
     * the handler has returned.
     *
     * @param {number[]} args  NumFaces, NumVertices, Options, then as the call has them.
     * @param {import('./fvf.js').VertexElement[] | null} elements @param {number} fvf
     * @returns {number | Promise<number>}
     */
    const createMesh = ([faces, vertices, options, , device, out], elements, fvf)=>{
        if ((out >>> 0) !== 0)
        {
            putU32s(out, [0]);
        }
        if ((out >>> 0) === 0 || (device >>> 0) === 0 || (faces >>> 0) === 0
            || (vertices >>> 0) === 0 || !elements || declVertexSize(elements, 0) === 0
            || (!(options & D3DXMESH_32BIT) && (vertices >>> 0) > 0x10000)
            || !host.callGuest || !host.heap || !host.vtables)
        {
            return D3DERR_INVALIDCALL;
        }
        const thread = host.currentThread?.();
        return Promise.resolve().then(()=>make({ device: device >>> 0, faces: faces >>> 0,
            vertices: vertices >>> 0, options: options >>> 0, elements, fvf }, thread))
            .then(made=>{
                if (made.answer === D3D_OK)
                {
                    putU32s(out, [made.pointer]);
                }
                return made.answer;
            });
    };

    return {
        make, baseMesh, mesh, throughLock, writeIndices,
        /** @param {number} pointer */
        meshAt: pointer=>byPointer.get(pointer >>> 0) ?? null,
        exports: {
            /**
             * HRESULT D3DXCreateMesh(DWORD NumFaces, DWORD NumVertices, DWORD Options,
             *     const D3DVERTEXELEMENT9 *pDeclaration, LPDIRECT3DDEVICE9 pD3DDevice,
             *     LPD3DXMESH *ppMesh)
             */
            D3DXCreateMesh: {
                argBytes: 24,
                /** @param {number[]} args */
                handler: args=>{
                    const elements = (args[3] >>> 0) === 0 ? null
                        : readDeclaration(host.readMemory, args[3]);
                    return createMesh(args, elements, elements ? fvfFromDeclarator(elements) ?? 0
                        : 0);
                },
            },
            /**
             * HRESULT D3DXCreateMeshFVF(DWORD NumFaces, DWORD NumVertices, DWORD Options,
             *     DWORD FVF, LPDIRECT3DDEVICE9 pD3DDevice, LPD3DXMESH *ppMesh)
             */
            D3DXCreateMeshFVF: {
                argBytes: 24,
                /** @param {number[]} args */
                handler: args=>createMesh(args, declaratorFromFvf(args[3] >>> 0), args[3] >>> 0),
            },
        },
    };
}
