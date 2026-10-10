/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A device for D3DX's tests: guest memory, a heap, and Direct3D 9 objects
 * reached only through the vtables their pointers lead to, as a program
 * reaches them. Each slot of every vtable holds the entry 0xE0000 + slot, and
 * the fake bridge dispatches on the object and the slot; every call is
 * recorded by name.
 *
 * Like the bridge, it refuses a call into the guest made before the handler
 * that makes it has returned.
 */

import { layoutOf } from './pixels.js';

const D3DUSAGE_RENDERTARGET = 0x1;
const D3DUSAGE_DEPTHSTENCIL = 0x2;
const D3DPOOL_DEFAULT = 0;

/** What each slot is called, by kind, for the record. */
const NAMES = {
    device: { 1: 'AddRef', 2: 'Release', 7: 'GetDeviceCaps', 23: 'CreateTexture',
        27: 'CreateIndexBuffer', 28: 'CreateRenderTarget', 29: 'CreateDepthStencilSurface',
        37: 'SetRenderTarget', 38: 'GetRenderTarget', 39: 'SetDepthStencilSurface',
        40: 'GetDepthStencilSurface', 41: 'BeginScene', 42: 'EndScene', 47: 'SetViewport',
        48: 'GetViewport', 57: 'SetRenderState', 59: 'CreateStateBlock', 65: 'SetTexture',
        67: 'SetTextureStageState', 69: 'SetSamplerState', 83: 'DrawPrimitiveUP',
        89: 'SetFVF', 92: 'SetVertexShader', 107: 'SetPixelShader' },
    texture: { 1: 'AddRef', 2: 'Release', 3: 'GetDevice', 10: 'GetType', 13: 'GetLevelCount',
        17: 'GetLevelDesc', 18: 'GetSurfaceLevel', 19: 'LockRect', 20: 'UnlockRect' },
    surface: { 1: 'AddRef', 2: 'Release', 3: 'GetDevice', 10: 'GetType', 12: 'GetDesc',
        13: 'LockRect', 14: 'UnlockRect' },
    indices: { 1: 'AddRef', 2: 'Release', 11: 'Lock', 12: 'Unlock', 13: 'GetDesc' },
    block: { 1: 'AddRef', 2: 'Release', 5: 'Apply' },
    mesh: { 1: 'AddRef', 2: 'Release', 4: 'GetNumFaces', 5: 'GetNumVertices', 6: 'GetFVF',
        7: 'GetDeclaration', 8: 'GetNumBytesPerVertex', 9: 'GetOptions', 10: 'GetDevice',
        15: 'LockVertexBuffer', 16: 'UnlockVertexBuffer', 17: 'LockIndexBuffer',
        18: 'UnlockIndexBuffer', 19: 'GetAttributeTable', 21: 'ConvertAdjacencyToPointReps' },
};

/** Texel bytes of the uncompressed formats a test makes, for the pitch. */
const BYTES = new Map([[20, 3], [21, 4], [22, 4], [23, 2], [24, 2], [25, 2], [26, 2], [28, 1],
    [32, 4], [50, 1], [51, 2], [113, 8], [114, 4], [116, 16]]);

/**
 * @param {{ caps?: Partial<Record<'textureCaps' | 'maxWidth' | 'maxHeight', number>>,
 *     viewport?: number[] }} [options]
 */
export function deviceRig(options = {}){
    const memory = new Uint8Array(1 << 22);
    const view = new DataView(memory.buffer);
    let next = 0x1000;
    /** @type {Set<number>} */
    const live = new Set();
    const heap = {
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += (Math.max(bytes, 1) + 15) & ~15;
            if (next > memory.length)
            {
                throw new Error('the test heap is full');
            }
            live.add(at);
            return at;
        },
        free: (/** @type {number} */ at)=>{
            live.delete(at);
        },
    };
    /** @type {any[][]} */
    const calls = [];
    /** @type {Map<number, any>} */
    const objects = new Map();
    /** @param {any} state */
    const object = state=>{
        const at = heap.allocate(4);
        const vtable = heap.allocate(128 * 4);
        view.setUint32(at, vtable, true);
        for (let slot = 0; slot < 128; slot++)
        {
            view.setUint32(vtable + slot * 4, 0xe0000 + slot, true);
        }
        objects.set(at, { refs: 1, ...state });
        return at;
    };
    const pitchOf = (/** @type {number} */ format, /** @type {number} */ width)=>
        (BYTES.has(format) ? width * /** @type {number} */ (BYTES.get(format))
            : layoutOf(format, width, 1).rowBytes);
    const rowsOf = (/** @type {number} */ format, /** @type {number} */ height)=>
        (BYTES.has(format) ? height : layoutOf(format, 4, height).rows);
    /** @param {any} state */
    const surface = state=>object({ kind: 'surface', locked: false, ...state,
        pitch: pitchOf(state.format, state.width),
        data: heap.allocate(pitchOf(state.format, state.width)
            * rowsOf(state.format, state.height)) });

    /**
     * A texture whose levels are surfaces of their own.
     *
     * @param {number} width @param {number} height @param {number} levels
     * @param {number} usage @param {number} format @param {number} pool
     */
    const texture = (width, height, levels, usage, format, pool)=>{
        const count = levels === 0
            ? Math.floor(Math.log2(Math.max(width, height))) + 1 : levels;
        const surfaces = Array.from({ length: count }, (_, level)=>surface({
            width: Math.max(1, width >> level), height: Math.max(1, height >> level), format,
            usage, pool }));
        return object({ kind: 'texture', width, height, usage, format, pool, surfaces });
    };

    const caps = { textureCaps: 0, maxWidth: 4096, maxHeight: 4096, ...options.caps };
    let viewport = options.viewport ?? [0, 0, 640, 480, 0, 1];
    const backBuffer = surface({ width: viewport[2], height: viewport[3], format: 22,
        usage: D3DUSAGE_RENDERTARGET, pool: D3DPOOL_DEFAULT });
    const depth = surface({ width: viewport[2], height: viewport[3], format: 75,
        usage: D3DUSAGE_DEPTHSTENCIL, pool: D3DPOOL_DEFAULT });
    const device = object({ kind: 'device', target: backBuffer, depth });

    /** @param {number} at @param {number} value */
    const put = (at, value)=>view.setUint32(at, value >>> 0, true);
    /** @param {number} at @param {number[]} values */
    const putAll = (at, values)=>values.forEach((v, i)=>put(at + i * 4, v));
    /** @param {number} at */
    const addRef = at=>{
        objects.get(at).refs++;
        return at;
    };
    /** @param {number} at @param {any} self */
    const lock = (at, self)=>{
        self.locked = true;
        put(at, self.pitch);
        put(at + 4, self.data);
        return 0;
    };
    /** @param {number} at @param {any} self */
    const surfaceDesc = (at, self)=>{
        putAll(at, [self.format, 1, self.usage, self.pool, 0, 0, self.width, self.height]);
        return 0;
    };

    /** The program's own functions, by the entry a test gave them. @type {Map<number, any>} */
    const functions = new Map();
    /**
     * A function of the program's, called with its arguments; its entry.
     *
     * @param {(args: number[]) => number} fn
     */
    const guestFunction = fn=>{
        const entry = 0xf0000 + functions.size * 16;
        functions.set(entry, fn);
        return entry;
    };

    let inHandler = false;
    const callGuest = async(/** @type {{ entry: number, args: number[] }} */ { entry, args })=>{
        if (inHandler)
        {
            throw new Error('a call into the guest before the handler returned');
        }
        const own = functions.get(entry);
        if (own)
        {
            return own(args);
        }
        const slot = entry - 0xe0000;
        const self = objects.get(args[0] >>> 0);
        if (!self)
        {
            throw new Error(`a call through ${args[0]}, which is no object`);
        }
        const name = /** @type {any} */ (NAMES)[self.kind]?.[slot] ?? `${self.kind} ${slot}`;
        calls.push([name, ...args.slice(1)]);
        if (slot === 1)
        {
            return ++self.refs;
        }
        if (slot === 2)
        {
            return --self.refs;
        }
        if (self.kind === 'device')
        {
            switch (slot)
            {
                case 7: {
                    const at = args[1];
                    memory.fill(0, at, at + 304);
                    put(at + 60, caps.textureCaps);
                    put(at + 88, caps.maxWidth);
                    put(at + 92, caps.maxHeight);
                    return 0;
                }
                case 23: {
                    const [, width, height, levels, usage, format, pool, out] = args;
                    put(out, texture(width, height, levels, usage, format, pool));
                    return 0;
                }
                case 27: {
                    const [, length, usage, format, pool, out] = args;
                    put(out, object({ kind: 'indices', length, usage, format, pool,
                        data: heap.allocate(length), pitch: 0 }));
                    return 0;
                }
                case 28: {
                    const [, width, height, format, , , lockable, out] = args;
                    put(out, surface({ width, height, format, usage: D3DUSAGE_RENDERTARGET,
                        pool: D3DPOOL_DEFAULT, lockable }));
                    return 0;
                }
                case 29: {
                    const [, width, height, format, , , , out] = args;
                    put(out, surface({ width, height, format, usage: D3DUSAGE_DEPTHSTENCIL,
                        pool: D3DPOOL_DEFAULT }));
                    return 0;
                }
                case 37:
                    self.target = args[2];
                    viewport = [0, 0, objects.get(args[2]).width, objects.get(args[2]).height,
                        0, 1];
                    return 0;
                case 38:
                    put(args[2], addRef(self.target));
                    return 0;
                case 39:
                    self.depth = args[1];
                    return 0;
                case 40:
                    put(args[1], self.depth === 0 ? 0 : addRef(self.depth));
                    return self.depth === 0 ? 0x8876086c : 0;
                case 47: {
                    const words = new DataView(memory.buffer, args[1], 24);
                    viewport = [0, 1, 2, 3].map(i=>words.getUint32(i * 4, true))
                        .concat([words.getFloat32(16, true), words.getFloat32(20, true)]);
                    return 0;
                }
                case 48: {
                    putAll(args[1], viewport.slice(0, 4));
                    view.setFloat32(args[1] + 16, viewport[4], true);
                    view.setFloat32(args[1] + 20, viewport[5], true);
                    return 0;
                }
                case 59:
                    put(args[2], object({ kind: 'block' }));
                    return 0;
                default:
                    return 0;
            }
        }
        if (self.kind === 'texture')
        {
            switch (slot)
            {
                case 3:
                    put(args[1], addRef(device));
                    return 0;
                case 10:
                    return 3;
                case 13:
                    return self.surfaces.length;
                case 17:
                    return args[1] >= self.surfaces.length ? 0x8876086c
                        : surfaceDesc(args[2], objects.get(self.surfaces[args[1]]));
                case 18:
                    put(args[2], addRef(self.surfaces[args[1]]));
                    return 0;
                case 19:
                    return args[1] >= self.surfaces.length ? 0x8876086c
                        : lock(args[2], objects.get(self.surfaces[args[1]]));
                case 20:
                    objects.get(self.surfaces[args[1]]).locked = false;
                    return 0;
                default:
                    return 0;
            }
        }
        if (self.kind === 'surface')
        {
            switch (slot)
            {
                case 3:
                    put(args[1], addRef(device));
                    return 0;
                case 12:
                    return surfaceDesc(args[1], self);
                case 13:
                    return lock(args[1], self);
                case 14:
                    self.locked = false;
                    return 0;
                default:
                    return 0;
            }
        }
        if (self.kind === 'indices')
        {
            if (slot === 11)
            {
                put(args[3], self.data);
            }
            return 0;
        }
        if (self.kind === 'mesh')
        {
            return self.call(slot, args);
        }
        return 0;
    };

    /**
     * A mesh as a program might hold one: its vertices and 16- or 32-bit
     * indices in guest memory, its declaration, its attribute table, and the
     * point representatives it answers for an adjacency.
     *
     * @param {{ declaration: number[][], stride: number, vertices: number,
     *     indices: number[], options?: number, ranges?: number[][],
     *     pointReps?: (adjacency: number) => number[] }} spec
     */
    const mesh = spec=>{
        const wide = ((spec.options ?? 0) & 1) !== 0;
        const vertexData = heap.allocate(spec.vertices * spec.stride);
        const indexData = heap.allocate(spec.indices.length * (wide ? 4 : 2));
        spec.indices.forEach((index, i)=>(wide ? view.setUint32(indexData + i * 4, index, true)
            : view.setUint16(indexData + i * 2, index, true)));
        const state = { kind: 'mesh', vertexData, indexData, locks: 0,
            /** @param {number} slot @param {number[]} args */
            call: (slot, args)=>{
                switch (slot)
                {
                    case 4: return spec.indices.length / 3;
                    case 5: return spec.vertices;
                    case 7: {
                        const rows = [...spec.declaration, [0xff, 0, 17, 0, 0, 0]];
                        rows.forEach(([stream, offset, type, method, usage, index], i)=>{
                            const at = args[1] + i * 8;
                            view.setUint16(at, stream, true);
                            view.setUint16(at + 2, offset, true);
                            memory.set([type, method, usage, index], at + 4);
                        });
                        return 0;
                    }
                    case 8: return spec.stride;
                    case 9: return spec.options ?? 0;
                    case 10:
                        put(args[1], addRef(device));
                        return 0;
                    case 15:
                        state.locks++;
                        put(args[2], vertexData);
                        return 0;
                    case 17:
                        state.locks++;
                        put(args[2], indexData);
                        return 0;
                    case 16: case 18:
                        state.locks--;
                        return 0;
                    case 19: {
                        const ranges = spec.ranges ?? [];
                        if (args[1] !== 0)
                        {
                            ranges.forEach((range, i)=>putAll(args[1] + i * 20, range));
                        }
                        if (args[2] !== 0)
                        {
                            put(args[2], ranges.length);
                        }
                        return 0;
                    }
                    case 21: {
                        const reps = spec.pointReps?.(args[1])
                            ?? Array.from({ length: spec.vertices }, (_, i)=>i);
                        putAll(args[2], reps);
                        return 0;
                    }
                    default:
                        return 0;
                }
            } };
        return object(state);
    };

    let published = 0x90000000;
    /** @type {string[][]} */
    const diverged = [];
    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            memory.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, at),
        heap, callGuest,
        vtables: { publish: ()=>(published += 4) },
        currentThread: ()=>undefined,
        divergence: (/** @type {string} */ api, /** @type {string} */ detail)=>
            diverged.push([api, detail]),
    };

    /**
     * A method of a descriptor, the way the bridge calls it: the handler's
     * return comes before any call it makes into the guest.
     *
     * @param {any} descriptor @param {string} name @param {any} target @param {number[]} args
     */
    const invoke = (descriptor, name, target, args)=>{
        const one = descriptor.methods.find((/** @type {any} */ m)=>m.name === name);
        if (!one)
        {
            throw new Error(`no method ${name}`);
        }
        inHandler = true;
        try
        {
            return one.invoke(target, args);
        }
        finally
        {
            inHandler = false;
        }
    };

    /**
     * An export's handler, called the same way.
     *
     * @param {{ handler: (args: number[]) => any }} entry @param {number[]} args
     */
    const call = (entry, args)=>{
        inHandler = true;
        try
        {
            return entry.handler(args);
        }
        finally
        {
            inHandler = false;
        }
    };

    /** @param {number} at @param {number[]} values */
    const putFloats = (at, values)=>values.forEach((v, i)=>view.setFloat32(at + i * 4, v, true));
    /** @param {number} at @param {number} count */
    const floats = (at, count)=>Array.from({ length: count }, (_, i)=>
        view.getFloat32(at + i * 4, true));

    return { memory, view, heap, host, device, objects, calls, diverged, invoke, call,
        texture, surface, mesh, object, putFloats, floats, live, guestFunction,
        get viewport(){
            return viewport;
        } };
}
