/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The machine the seam's gates run a program on: the real processor with the
 * bridge's tables laid out in its memory and the seam's own trap handlers
 * answering them, made with the guest code on or off, so that one program run
 * on two of them side by side says whether the guest path is the host's. The
 * versions' tables and how their objects are made come with it. No tests of
 * its own.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import * as cork from '../../../../../cork/src/index.js';
import { createVtables } from '../../bridge/internal/vtable.js';
import { IID_IUNKNOWN } from '../../win32/ole32/objects.js';
import { createGraphicsLibraries } from './exports.js';
import { createBackend } from '../webgpu/backend.js';
import { playedAtOnce, playedDirect3D, recordedDirect3D } from '../remote/direct3d.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { COMMAND_RING_BYTES, SHADOW } from './shadow.js';
import { guidBytes } from './d3d7.js';
import {
    IDIRECT3D8_SLOTS, IDIRECT3D9_SLOTS, IDIRECT3DBASETEXTURE8_SLOTS, IDIRECT3DCUBETEXTURE8_SLOTS,
    IDIRECT3DDEVICE8_SLOTS, IDIRECT3DSURFACE8_SLOTS, IDIRECT3DTEXTURE8_SLOTS,
    IDIRECT3DVERTEXBUFFER8_SLOTS, IDIRECT3DVOLUME8_SLOTS, IDIRECT3DVOLUMETEXTURE8_SLOTS,
} from './vtables.js';
import {
    IID_IDirect3DBaseTexture8, IID_IDirect3DCubeTexture8, IID_IDirect3DDevice8,
    IID_IDirect3DIndexBuffer8, IID_IDirect3DResource8, IID_IDirect3DSurface8,
    IID_IDirect3DTexture8, IID_IDirect3DVertexBuffer8, IID_IDirect3DVolume8,
    IID_IDirect3DVolumeTexture8,
} from './iids.js';
import {
    IDIRECT3DBASETEXTURE9_SLOTS, IDIRECT3DCUBETEXTURE9_SLOTS, IDIRECT3DDEVICE9_SLOTS,
    IDIRECT3DQUERY9_SLOTS, IDIRECT3DSTATEBLOCK9_SLOTS, IDIRECT3DSURFACE9_SLOTS,
    IDIRECT3DTEXTURE9_SLOTS, IDIRECT3DVERTEXBUFFER9_SLOTS, IDIRECT3DVOLUME9_SLOTS,
    IDIRECT3DVOLUMETEXTURE9_SLOTS,
    IID_IDirect3DBaseTexture9, IID_IDirect3DCubeTexture9, IID_IDirect3DDevice9,
    IID_IDirect3DIndexBuffer9, IID_IDirect3DResource9, IID_IDirect3DStateBlock9,
    IID_IDirect3DSurface9, IID_IDirect3DTexture9, IID_IDirect3DVertexBuffer9,
    IID_IDirect3DVolume9, IID_IDirect3DVolumeTexture9,
} from '../d3d9/interfaces.js';
import { createDirect3D9 } from '../d3d9/device.js';
import { createDirect3D8 } from '../d3d8/device.js';
import { commandObjects as commandObjects9 } from '../d3d9/commands.js';
import { D3D8_COMMANDS } from '../d3d8/commands.js';

export const PROGRAM = 0x8000;
export const STACK = 0x300000;
/** The out-parameters and the GUIDs a call is handed. */
export const OUT = 0x10000;
export const GUID = 0x10100;
/** One `hlt` per method the bridge registers: where a call reaches the host. */
export const TRAPS = 0x100000;
/** Where the routines the seam and the bridge place go. */
export const CODE = 0x200000;
/** The arena interface blocks, device blocks, rings and count words come out of. */
export const HEAP = 0x400000;
export const HEAP_END = 0x3f00000;
/** What an out-parameter holds before the call, to tell one left alone. */
export const UNTOUCHED = 0xdeadbeef;
export const HWND = 0x00010044;

export const D3DFMT_X8R8G8B8 = 22;
export const D3DFMT_A8R8G8B8 = 21;
export const D3DFMT_D24S8 = 75;
export const D3DFMT_INDEX16 = 101;
export const D3DPOOL_MANAGED = 1;
export const D3DSBT_ALL = 1;
export const FVF_XYZ_DIFFUSE = 0x042;
export const SOFTWARE_VERTEXPROCESSING = 0x20;

/** @param {number} value @returns {number[]} */
export const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {[string, number][]} slots @param {string} name */
export const slotIn = (slots, name)=>{
    const index = slots.findIndex(([entry])=>entry === name);
    assert.ok(index >= 0, `${name} is a slot`);
    return 3 + index;
};

/**
 * Choices drawn from a seed, the same for the same seed on every run: a
 * failing seed is the same program again.
 */
export const random = (/** @type {number} */ seed)=>{
    let drawn = 0;
    const next = ()=>createHash('sha256').update(`${seed}:${drawn++}`).digest()
        .readUInt32LE(0) / 4294967296;
    return {
        /** @param {number} n */
        below: n=>Math.floor(next() * n),
        /** @template T @param {T[]} list @returns {T} */
        pick: list=>list[Math.floor(next() * list.length)],
    };
};

/**
 * What one version's program is made of: its slot tables, the interfaces each
 * kind of object answers a query for, and how its device and resources are
 * made.
 *
 * @typedef {Object} Version
 * @property {string} library
 * @property {string} entry
 * @property {(caps?: object) => any} root
 * @property {[string, number][]} rootSlots
 * @property {number[]} presentParameters
 * @property {Record<string, [string, number][]>} slots  by kind
 * @property {Record<string, string[]>} queries  by kind: the interfaces asked for
 * @property {Record<string, { method: string, args: (number | string)[] }>} creates
 * @property {(records: Uint8Array, objectAt: (pointer: number) => any) => any[]} commandObjects
 * @property {(stream: number, buffer: string | number) => (number | string)[]} setStream
 * @property {(buffer: string | number) => (number | string)[]} setIndices
 * @property {(number | string)[]} getStream
 * @property {(number | string)[]} getIndices
 * @property {(number | string)[]} getBackBuffer
 * @property {(number | string)[]} getRenderTarget
 * @property {(target: string, depth: string | number) => [string, (number | string)[]][]}
 *     setTargets  the calls that make these the target and the depth surface
 * @property {string[]} textureKinds  kinds SetTexture takes
 */

/** @type {Version} */
export const D3D9 = {
    library: 'D3D9.dll',
    entry: 'Direct3DCreate9',
    root: caps=>createDirect3D9(caps),
    rootSlots: IDIRECT3D9_SLOTS,
    // D3DPRESENT_PARAMETERS: 64 by 64, one back buffer, DISCARD, windowed, a D24S8 depth surface.
    presentParameters: [64, 64, D3DFMT_X8R8G8B8, 1, 0, 0, 1, HWND, 1, 1, D3DFMT_D24S8, 0, 0, 0],
    slots: {
        device: IDIRECT3DDEVICE9_SLOTS, texture: IDIRECT3DTEXTURE9_SLOTS,
        level: IDIRECT3DSURFACE9_SLOTS, cube: IDIRECT3DCUBETEXTURE9_SLOTS,
        face: IDIRECT3DSURFACE9_SLOTS, volumeTexture: IDIRECT3DVOLUMETEXTURE9_SLOTS,
        volume: IDIRECT3DVOLUME9_SLOTS, vertices: IDIRECT3DVERTEXBUFFER9_SLOTS,
        indices: IDIRECT3DVERTEXBUFFER9_SLOTS, block: IDIRECT3DSTATEBLOCK9_SLOTS,
        surface: IDIRECT3DSURFACE9_SLOTS, target: IDIRECT3DSURFACE9_SLOTS,
        depth: IDIRECT3DSURFACE9_SLOTS, depthSurface: IDIRECT3DSURFACE9_SLOTS,
        base: IDIRECT3DBASETEXTURE9_SLOTS, query: IDIRECT3DQUERY9_SLOTS, unknown: [],
    },
    queries: {
        device: [IID_IUNKNOWN, IID_IDirect3DDevice9, IID_IDirect3DTexture9],
        texture: [IID_IUNKNOWN, IID_IDirect3DTexture9, IID_IDirect3DBaseTexture9,
            IID_IDirect3DResource9, IID_IDirect3DVertexBuffer9],
        level: [IID_IUNKNOWN, IID_IDirect3DSurface9, IID_IDirect3DResource9,
            IID_IDirect3DTexture9],
        cube: [IID_IUNKNOWN, IID_IDirect3DCubeTexture9, IID_IDirect3DBaseTexture9],
        face: [IID_IUNKNOWN, IID_IDirect3DSurface9],
        volumeTexture: [IID_IUNKNOWN, IID_IDirect3DVolumeTexture9, IID_IDirect3DBaseTexture9],
        volume: [IID_IUNKNOWN, IID_IDirect3DVolume9, IID_IDirect3DResource9],
        vertices: [IID_IUNKNOWN, IID_IDirect3DVertexBuffer9, IID_IDirect3DResource9,
            IID_IDirect3DIndexBuffer9],
        indices: [IID_IUNKNOWN, IID_IDirect3DIndexBuffer9],
        block: [IID_IUNKNOWN, IID_IDirect3DStateBlock9],
        surface: [IID_IUNKNOWN, IID_IDirect3DSurface9, IID_IDirect3DResource9],
        target: [IID_IUNKNOWN, IID_IDirect3DSurface9],
        depth: [IID_IUNKNOWN, IID_IDirect3DSurface9],
        depthSurface: [IID_IUNKNOWN, IID_IDirect3DSurface9],
        base: [IID_IUNKNOWN, IID_IDirect3DBaseTexture9],
        unknown: [IID_IUNKNOWN],
    },
    creates: {
        texture: { method: 'CreateTexture',
            args: [16, 16, 'levels', 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, 'out', 0] },
        cube: { method: 'CreateCubeTexture',
            args: [16, 2, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, 'out', 0] },
        volumeTexture: { method: 'CreateVolumeTexture',
            args: [8, 8, 4, 2, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, 'out', 0] },
        vertices: { method: 'CreateVertexBuffer',
            args: [256, 0, FVF_XYZ_DIFFUSE, D3DPOOL_MANAGED, 'out', 0] },
        indices: { method: 'CreateIndexBuffer',
            args: [64, 0, D3DFMT_INDEX16, D3DPOOL_MANAGED, 'out', 0] },
        block: { method: 'CreateStateBlock', args: [D3DSBT_ALL, 'out'] },
        target: { method: 'CreateRenderTarget',
            args: [64, 64, D3DFMT_X8R8G8B8, 0, 0, 0, 'out', 0] },
        depth: { method: 'CreateDepthStencilSurface',
            args: [64, 64, D3DFMT_D24S8, 0, 0, 0, 'out', 0] },
    },
    commandObjects: commandObjects9,
    setStream: (stream, buffer)=>[stream, buffer, 0, 16],
    setIndices: buffer=>[buffer],
    getStream: [0, 'out', 'out2', 'out3'],
    getIndices: ['out'],
    getBackBuffer: [0, 0, 0, 'out'],
    getRenderTarget: [0, 'out'],
    setTargets: (target, depth)=>[['SetRenderTarget', [0, target]],
        ['SetDepthStencilSurface', [depth]]],
    textureKinds: ['texture', 'cube', 'volumeTexture'],
};

/** @type {Version} */
export const D3D8 = {
    library: 'D3D8.dll',
    entry: 'Direct3DCreate8',
    root: caps=>createDirect3D8(caps),
    rootSlots: IDIRECT3D8_SLOTS,
    presentParameters: [64, 64, D3DFMT_X8R8G8B8, 1, 0, 1, HWND, 1, 1, D3DFMT_D24S8, 0, 0, 0],
    slots: {
        device: IDIRECT3DDEVICE8_SLOTS, texture: IDIRECT3DTEXTURE8_SLOTS,
        level: IDIRECT3DSURFACE8_SLOTS, cube: IDIRECT3DCUBETEXTURE8_SLOTS,
        face: IDIRECT3DSURFACE8_SLOTS, volumeTexture: IDIRECT3DVOLUMETEXTURE8_SLOTS,
        volume: IDIRECT3DVOLUME8_SLOTS, vertices: IDIRECT3DVERTEXBUFFER8_SLOTS,
        indices: IDIRECT3DVERTEXBUFFER8_SLOTS, surface: IDIRECT3DSURFACE8_SLOTS,
        target: IDIRECT3DSURFACE8_SLOTS, depth: IDIRECT3DSURFACE8_SLOTS,
        depthSurface: IDIRECT3DSURFACE8_SLOTS, base: IDIRECT3DBASETEXTURE8_SLOTS, unknown: [],
    },
    queries: {
        device: [IID_IUNKNOWN, IID_IDirect3DDevice8, IID_IDirect3DTexture8],
        texture: [IID_IUNKNOWN, IID_IDirect3DTexture8, IID_IDirect3DBaseTexture8,
            IID_IDirect3DResource8, IID_IDirect3DVertexBuffer8],
        level: [IID_IUNKNOWN, IID_IDirect3DSurface8, IID_IDirect3DTexture8],
        cube: [IID_IUNKNOWN, IID_IDirect3DCubeTexture8, IID_IDirect3DBaseTexture8],
        face: [IID_IUNKNOWN, IID_IDirect3DSurface8],
        volumeTexture: [IID_IUNKNOWN, IID_IDirect3DVolumeTexture8, IID_IDirect3DBaseTexture8],
        volume: [IID_IUNKNOWN, IID_IDirect3DVolume8],
        vertices: [IID_IUNKNOWN, IID_IDirect3DVertexBuffer8, IID_IDirect3DResource8,
            IID_IDirect3DIndexBuffer8],
        indices: [IID_IUNKNOWN, IID_IDirect3DIndexBuffer8],
        surface: [IID_IUNKNOWN, IID_IDirect3DSurface8],
        target: [IID_IUNKNOWN, IID_IDirect3DSurface8],
        depth: [IID_IUNKNOWN, IID_IDirect3DSurface8],
        depthSurface: [IID_IUNKNOWN, IID_IDirect3DSurface8],
        base: [IID_IUNKNOWN, IID_IDirect3DBaseTexture8],
        unknown: [IID_IUNKNOWN],
    },
    creates: {
        texture: { method: 'CreateTexture',
            args: [16, 16, 'levels', 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, 'out'] },
        cube: { method: 'CreateCubeTexture',
            args: [16, 2, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, 'out'] },
        volumeTexture: { method: 'CreateVolumeTexture',
            args: [8, 8, 4, 2, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, 'out'] },
        vertices: { method: 'CreateVertexBuffer',
            args: [256, 0, FVF_XYZ_DIFFUSE, D3DPOOL_MANAGED, 'out'] },
        indices: { method: 'CreateIndexBuffer',
            args: [64, 0, D3DFMT_INDEX16, D3DPOOL_MANAGED, 'out'] },
        target: { method: 'CreateRenderTarget', args: [64, 64, D3DFMT_X8R8G8B8, 0, 0, 'out'] },
        depth: { method: 'CreateDepthStencilSurface', args: [64, 64, D3DFMT_D24S8, 0, 'out'] },
    },
    commandObjects: D3D8_COMMANDS.commandObjects,
    setStream: (stream, buffer)=>[stream, buffer, 16],
    setIndices: buffer=>[buffer, 0],
    getStream: [0, 'out', 'out2'],
    getIndices: ['out', 'out2'],
    getBackBuffer: [0, 0, 'out'],
    getRenderTarget: ['out'],
    setTargets: (target, depth)=>[['SetRenderTarget', [target, depth]]],
    textureKinds: ['texture', 'cube', 'volumeTexture'],
};

/**
 * One call as the program makes it: through the interface `on` names, the
 * method in that kind's table, its arguments -- a string names a pointer the
 * program holds, 'out' the out-parameter, 'out2' and 'out3' two more, a
 * `{ guid }` the address of those sixteen bytes, a `{ words }` of those.
 *
 * @typedef {{ on: string, kind: string, method: string,
 *     args: (number | string | { guid: string } | { words: number[] })[] }} Call
 */

/**
 * What a call answered, as the program can see it.
 *
 * @typedef {{ eax: number, out: string | number | null, out2: number, out3: number,
 *     traps: string[] }} Answer
 */

/**
 * The processor with the seam over it, the bridge's tables laid out in its
 * memory and its traps answered by the seam's own handlers.
 *
 * @param {Version} version
 * @param {boolean} guestCode
 * @param {{ onDevice?: (device: any) => void, gpu?: boolean, worker?: boolean,
 *     caps?: object }} [options]
 *     `onDevice` is told of each device made; `gpu` has the devices draw
 *     through a backend over a recording GPU, the machine's `gpu`; `worker`
 *     has them record what they are asked, as in a graphics worker, for a
 *     twin that plays each call at once to draw; `caps` is what the root is
 *     told its devices can do, past what every device of the version can
 */
export function machine(version, guestCode, options = {}){
    /** @type {(device: any) => void} */
    const onDevice = options.onDevice ?? (()=>{});
    const gpu = options.gpu ? createFakeDevice() : null;
    const host = createCorkHost({
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: {},
    });
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    /** @param {number} at @param {number} length */
    const readBytes = (at, length)=>host.readPhysical(at >>> 0, length).slice();
    /** @param {number} at @param {Uint8Array} bytes */
    const writeBytes = (at, bytes)=>host.writePhysical(at >>> 0, bytes);
    /** @param {number} at */
    const readU32 = at=>{
        const b = host.readPhysical(at >>> 0, 4);
        return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
    };
    /** @param {number} at @param {number} value */
    const writeU32 = (at, value)=>writeBytes(at, new Uint8Array(u32(value >>> 0)));
    const memory = { readBytes, writeBytes, readMemory: readBytes, writeMemory: writeBytes,
        readU32, writeU32 };

    let heap = HEAP;
    let code = CODE;
    /** @param {number} bytes */
    const allocate = bytes=>{
        const align = bytes >= 4096 ? 4096 : 16;
        const at = (heap + align - 1) & -align;
        if (at + bytes > HEAP_END)
        {
            return 0;
        }
        heap = at + bytes;
        return at;
    };
    /** @param {number} bytes */
    const allocateCode = bytes=>{
        const at = (code + 15) & -16;
        code = at + bytes;
        assert.ok(code < HEAP, 'the routines fit below the arena');
        return at;
    };

    /** @type {Map<number, { name: string, fn: any }>} */
    const handlers = new Map();
    let nextTrap = TRAPS;
    const vtables = createVtables({
        memory,
        heap: { allocate, allocateCode },
        register: (name, fn)=>{
            const at = nextTrap++;
            host.writePhysical(at, new Uint8Array([0xf4]));
            handlers.set(at, { name, fn });
            return at;
        },
    });

    /**
     * What a played run of the ring named that the host had let go of.
     *
     * @type {string[]}
     */
    const gone = [];
    /** @param {any} object */
    const ended = object=>(typeof object?.destroyed === 'boolean' ? object.destroyed
        : object?.counter && typeof object.counter.destroyed === 'boolean'
            ? object.counter.destroyed : object?.refCount === 0);
    /** How far into the ring the host has played, as `createCommandReader` keeps it. */
    let played = 0;
    /** @param {any} device */
    const watch = device=>{
        const play = device.commands;
        device.commands = (/** @type {Uint8Array} */ records, /** @type {any[]} */ objects)=>{
            played += records.byteLength;
            const named = version.commandObjects(records, pointer=>pointer);
            named.forEach((pointer, i)=>{
                const object = objects[i];
                if (pointer !== 0 && (object === null || object === undefined || ended(object)))
                {
                    gone.push(`a record names ${nameOf.get(pointer) ?? pointer}, whose object `
                        + (object ? 'the host has let go of' : 'is no longer published'));
                }
            });
            return play.call(device, records, objects);
        };
    };
    const libraries = createGraphicsLibraries({
        graphics: {
            create: (/** @type {string} */ name)=>{
                if (name !== (version === D3D9 ? 'd3d9' : 'd3d8'))
                {
                    return null;
                }
                // The device keeps its resources in this machine's memory, as
                // the graphics layer has it keep them in the guest's, and
                // draws through a backend over the recording GPU when asked.
                const services = { ...options.caps, allocate, free: ()=>{},
                    readMemory: readBytes, writeMemory: writeBytes, windowMemory: readBytes };
                const drawing = gpu ? {
                    backend: createBackend({ device: gpu.device, queue: gpu.queue,
                        presentTo: ()=>{}, now: ()=>0 }),
                    createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler',
                        id: `sampler-${JSON.stringify(descriptor)}`, descriptor }),
                } : {};
                // In a graphics worker the program's device records, and a
                // twin plays what it recorded and draws.
                const root = options.worker
                    ? recordedDirect3D(version.root, services, playedAtOnce(playedDirect3D(
                        version.root, { ...options.caps, ...drawing, readMemory: true,
                            writeMemory: writeBytes })))
                    : version.root({ ...services, ...drawing });
                const make = root.CreateDevice;
                root.CreateDevice = (/** @type {any[]} */ ...args)=>{
                    const hr = make.apply(root, args);
                    if (args[1]?.device)
                    {
                        watch(args[1].device);
                        onDevice(args[1].device);
                    }
                    return hr;
                };
                return root;
            },
            available: ()=>false,
            adapter: ()=>({ vendor: 'nvidia', architecture: 'ampere', description: '' }),
        },
        only: [version.library],
        memory,
        publishInterface: (object, id)=>vtables.publish(object, id),
        unpublishInterface: (object, id)=>vtables.unpublish(object, id),
        screen: ()=>({ width: 640, height: 480, bitsPerPixel: 32 }),
        windowClientSize: ()=>({ width: 64, height: 64 }),
        allocate,
        allocateCode,
        guestCode,
        // A ring of the size the gates fill many times over (`getters-contract`'s bursts).
        ringBytes: COMMAND_RING_BYTES,
        divergence: ()=>{},
        resolution: ()=>{},
        now: ()=>0,
    });

    /**
     * The program's names for what it was handed, by first appearance, and
     * the object behind each, kept past the pointer's end.
     *
     * @type {Map<number, string>}
     */
    const nameOf = new Map();
    /** @type {Map<string, number>} */
    const pointerOf = new Map();
    /** @type {Map<string, any>} */
    const objectOf = new Map();
    /** @param {number} pointer */
    const name = pointer=>{
        if (pointer === 0)
        {
            return null;
        }
        let known = nameOf.get(pointer);
        if (known === undefined)
        {
            known = `#${nameOf.size}`;
            nameOf.set(pointer, known);
            pointerOf.set(known, pointer);
            const owner = vtables.objectAt(pointer);
            objectOf.set(known, owner?.api ?? owner);
        }
        return known;
    };

    /**
     * Runs one call from a fresh stack until it returns, answering each trap
     * it reaches with the handler the bridge registered for it.
     *
     * @param {Call} call
     * @returns {Answer}
     */
    const run = call=>{
        const self = pointerOf.get(call.on);
        assert.ok(self !== undefined, `${call.on} is a pointer this machine handed out`);
        writeU32(OUT, UNTOUCHED);
        writeU32(OUT + 4, UNTOUCHED);
        writeU32(OUT + 8, UNTOUCHED);
        let guids = GUID;
        const values = call.args.map(arg=>{
            if (typeof arg === 'number')
            {
                return arg >>> 0;
            }
            if (typeof arg === 'object')
            {
                const bytes = 'guid' in arg ? guidBytes(arg.guid)
                    : new Uint8Array(new Uint32Array(arg.words).buffer);
                const at = guids;
                guids += (bytes.length + 15) & -16;
                writeBytes(at, bytes);
                return at;
            }
            if (arg === 'out' || arg === 'out2' || arg === 'out3')
            {
                return OUT + 4 * ['out', 'out2', 'out3'].indexOf(arg);
            }
            const pointer = pointerOf.get(arg);
            assert.ok(pointer !== undefined, `${arg} is a pointer this machine handed out`);
            return pointer;
        });
        const slot = call.method === 'QueryInterface' ? 0 : call.method === 'AddRef' ? 1
            : call.method === 'Release' ? 2
                : slotIn(call.kind === 'root' ? version.rootSlots : version.slots[call.kind],
                    call.method);
        /** @type {number[]} */
        const bytes = [];
        for (const value of [...values].reverse())
        {
            bytes.push(0x68, ...u32(value));
        }
        bytes.push(0x68, ...u32(self)); //               push this
        bytes.push(0xb8, ...u32(self)); //               mov eax, this
        bytes.push(0x8b, 0x00); //                       mov eax, [eax]
        bytes.push(0xff, 0x90, ...u32(slot * 4)); //     call [eax + slot*4]
        bytes.push(0xf4);
        const end = PROGRAM + bytes.length;
        host.writePhysical(PROGRAM, new Uint8Array(bytes));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        /** @type {string[]} */
        const traps = [];
        for (let slices = 0; ; slices++)
        {
            assert.ok(slices < 1000, `${call.method} returns`);
            host.runSlice(1 << 16);
            const eip = host.readReg32('eip');
            if (!host.halted())
            {
                continue;
            }
            if (eip === end)
            {
                break;
            }
            const entry = handlers.get(eip - 1);
            assert.ok(entry, `${call.method} stopped at 0x${eip.toString(16)}, no trap`);
            const esp = host.readReg32('esp');
            const words = entry.fn.argBytes >>> 2;
            const args = Array.from({ length: words }, (unused, i)=>readU32(esp + 4 + 4 * i));
            /** @type {any} */
            let answer;
            try
            {
                answer = entry.fn.handler(args);
            }
            catch (e){
                // What the bridge would end the process on: an answer of its own
                // here, so the other machine's is compared with it.
                return { eax: 0xffffffff, out: `${entry.name} threw: ${/** @type {Error} */ (e)
                    .message}`, out2: 0, out3: 0, traps: [...traps, entry.name] };
            }
            assert.ok(typeof answer?.then !== 'function', `${entry.name} answers at once`);
            traps.push(entry.name.replace(/^.*::/, ''));
            host.writeReg32('eax', (answer ?? 0) >>> 0);
            host.writeReg32('esp', esp + 4 + entry.fn.argBytes);
            host.writeReg32('eip', readU32(esp));
        }
        assert.equal(host.readReg32('esp'), STACK, `${call.method} popped what it was handed`);
        const out = readU32(OUT);
        return {
            eax: host.readReg32('eax'),
            out: out === UNTOUCHED ? 'untouched' : name(out),
            out2: readU32(OUT + 4),
            out3: readU32(OUT + 8),
            traps,
        };
    };

    /**
     * How much of the command ring waits to be played: from where the host
     * read to last to the head, which goes back to the start only once the
     * host has read everything before it.
     */
    const pending = ()=>{
        const device = pointerOf.get('#1');
        const block = device === undefined ? 0 : readU32(device + 4);
        const head = block === 0 ? 0 : readU32(block + SHADOW.COMMAND_HEAD);
        if (head < played)
        {
            played = 0;
        }
        return head - played;
    };

    const root = libraries.libraries[version.library][version.entry].handler([32]);
    assert.notEqual(root, 0, 'the entry point hands out a root');
    name(root);
    return {
        run,
        /** The machine's memory, for what a program writes through a pointer it was handed. */
        memory,
        /** The recording GPU the devices draw on, when asked for. */
        gpu,
        pending,
        /** The ring made ahead, as an executor with nothing to run does (`shadow.js` `drain`). */
        drain: ()=>libraries.drain(),
        gone,
        /** Which of the objects named so far the host has let go of, in naming order. */
        ended: ()=>[...objectOf.entries()].filter(([, object])=>ended(object))
            .map(([key])=>key),
        /**
         * What the count of the object a pointer reaches is the count of: a
         * level's, a face's or a volume's is its container's.
         *
         * @param {string} pointer
         */
        countOf: pointer=>{
            const object = objectOf.get(pointer);
            return object?.container && !object.container.GetBackBuffer ? object.container
                : object;
        },
    };
}
