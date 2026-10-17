/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The command ring's contract, as a gate: a call a command routine takes in
 * the guest is answered D3D_OK there and made on the device later, so it must
 * be a call the device takes. Every routine the seams place is run here by
 * the real processor on calls the device takes and on calls it refuses, in
 * the device states that decide which; what the routine recorded is then made
 * on a real device in that state. A routine that answered D3D_OK for a call
 * the device refuses fails the gate -- the program was told something that
 * is not so, and a program that checks the answer goes another way on it.
 *
 * The table names every command each version's ring carries, so a command
 * added to the ring without its cases here fails too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import * as cork from '../../../../../cork/src/index.js';
import { SHADOW, SURFACE, commandCode } from './shadow.js';
import { COMMAND_MIRRORS as MIRRORS_9 } from './d3d9.js';
import { COMMAND_MIRRORS as MIRRORS_8 } from './d3d8.js';
import * as D3D9 from '../d3d9/commands.js';
import { D3D8_COMMANDS } from '../d3d8/commands.js';
import { createDirect3D9 } from '../d3d9/device.js';
import { createDirect3D8 } from '../d3d8/device.js';
import { D3DDECLTYPE, D3DDECLUSAGE } from '../d3d9/declaration.js';

const PROGRAM = 0x8000;
const ROUTINE = 0x9000;
const TRAP = 0x8e00;
const BLOCK = 0xa000;
const RING = 0xd000;
const RING_BYTES = 0x4000;
const DATA = 0x14000;
const OBJECTS = 0x18000;
/** Each surface's block (`SURFACE`), the word after its interface pointing there. */
const SURFACES = 0x19000;
const STACK = 0x300000;
/** The device's interface: its block one word on. */
const DEVICE = OBJECTS + 0x800;

const D3D_OK = 0;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_D24S8 = 75;
const D3DFMT_D24X8 = 77;
const D3DFMT_INDEX16 = 101;
const D3DPOOL_DEFAULT = 0;
const D3DPOOL_MANAGED = 1;
const D3DUSAGE_RENDERTARGET = 0x1;
const D3DSWAPEFFECT_DISCARD = 1;
const FVF_XYZ_DIFFUSE = 0x042;
const D3DSBT_ALL = 1;
const ONE = new Uint32Array(new Float32Array([1]).buffer)[0];

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {number[]} values  Floats as their dwords. */
const floats = values=>[...new Uint32Array(new Float32Array(values).buffer)];

/**
 * One call: its arguments -- a string names an object the setup made, 'data'
 * the address of `data` -- the dwords the pointer argument points at, and the
 * device state it is made in.
 *
 * @typedef {{ label: string, args: (number | string)[], data?: number[],
 *     caps?: object, setup?: (device: any, made: Record<string, any>) => void }} Case
 */

/**
 * The processor, with the routine's block and ring in place.
 */
const machine = ()=>{
    const host = createCorkHost({
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: {},
    });
    host.writePhysical(TRAP, new Uint8Array([0xf4]));
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    host.writePhysical(DEVICE + 4, new Uint8Array(u32(BLOCK)));
    /** @param {number} at */
    const read = at=>{
        const bytes = host.readPhysical(at, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /**
     * Runs `routine` on `object` with `args` from a fresh block and ring:
     * the record it wrote, or null for a call it left to the trap.
     *
     * @param {Uint8Array} routine @param {number} object @param {number[]} args
     * @param {import('./shadow.js').ShadowRingState} state  the device's, as the host
     *     writes it into the block after each of its own calls
     * @param {Uint8Array} valid  the render states it answers for (`renderStatesOf`)
     */
    const run = (routine, object, args, state, valid)=>{
        start(state, valid);
        return call(routine, object, args);
    };
    /**
     * A fresh block and ring, holding what the host writes of the device's
     * state after each of its own calls.
     *
     * @param {import('./shadow.js').ShadowRingState} state @param {Uint8Array} valid
     */
    const start = (state, valid)=>{
        host.writePhysical(BLOCK, new Uint8Array(SHADOW.SIZE));
        host.writePhysical(BLOCK + SHADOW.COMMANDS,
            new Uint8Array([...u32(RING), ...u32(RING_BYTES)]));
        const words = new Uint32Array((SHADOW.SIZE - SHADOW.DRAWABLE) / 4);
        words.set([state.drawable, state.targetWidth, state.targetHeight, state.clipPlanes]);
        state.taken.forEach((value, table)=>{
            words[(SHADOW.VALIDATED - SHADOW.DRAWABLE) / 4 + table * SHADOW.VALIDATED_SLOTS] =
                value;
        });
        words[(SHADOW.COOPERATIVE - SHADOW.DRAWABLE) / 4] = state.cooperative ?? 1;
        words[(SHADOW.ELSEWHERE - SHADOW.DRAWABLE) / 4] = state.elsewhere ?? 0;
        host.writePhysical(BLOCK + SHADOW.DRAWABLE, new Uint8Array(words.buffer));
        host.writePhysical(BLOCK + SHADOW.RENDER_STATE_VALID, valid);
        host.writePhysical(RING, new Uint8Array(RING_BYTES));
    };
    /**
     * Runs `routine` with the block as it is: the ring so far, or null for a
     * call it left to the trap.
     *
     * @param {Uint8Array} routine @param {number} object @param {number[]} args
     */
    const call = (routine, object, args)=>{
        host.writePhysical(ROUTINE, routine);
        const before = read(BLOCK + SHADOW.COMMAND_HEAD);
        /** @type {number[]} */
        const code = [];
        for (const value of [...args].reverse())
        {
            code.push(0x68, ...u32(value));
        }
        code.push(0x68, ...u32(object));
        code.push(0xe8, ...u32((ROUTINE - (PROGRAM + code.length + 5)) | 0), 0xf4);
        host.writePhysical(PROGRAM, new Uint8Array(code));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        host.runSlice(10000);
        if (host.readReg32('eip') === TRAP + 1)
        {
            assert.equal(read(BLOCK + SHADOW.COMMAND_HEAD), before, 'a call left to the trap'
                + ' leaves the ring as it was');
            return null;
        }
        assert.equal(host.readReg32('eip'), PROGRAM + code.length, 'the routine returned');
        assert.equal(host.readReg32('eax'), D3D_OK, 'and answered D3D_OK');
        return host.readPhysical(RING, read(BLOCK + SHADOW.COMMAND_HEAD)).slice();
    };
    return { host, run, start, call };
};

/**
 * The render states a device answers for, a bit each, as the host mirrors
 * them into the block (`SHADOW.RENDER_STATE_VALID`).
 *
 * @param {any} device
 */
const renderStatesOf = device=>{
    const bits = new Uint8Array(SHADOW.RENDER_STATE_COUNT / 8);
    for (let state = 0; state < SHADOW.RENDER_STATE_COUNT; state++)
    {
        if (device.GetRenderState(state, {}) === D3D_OK)
        {
            bits[state >>> 3] |= 1 << (state & 7);
        }
    }
    return bits;
};

/**
 * A version's ring as the seam places it: its commands, the mirrors its
 * routines carry, and how a device of it is made.
 *
 * @typedef {Object} RingApi
 * @property {Readonly<Record<string, any>>} COMMANDS
 * @property {(name: string) => number} commandSlot
 * @property {(records: Uint8Array, objectAt: (pointer: number) => any) => any[]} commandObjects
 * @property {(device: any, records: Uint8Array, objects: readonly any[],
 *     refused: (name: string, hr: number) => void) => number} runCommands
 * @property {Record<string, any[]>} mirrors
 * @property {(caps?: object) => any} device
 */

/**
 * Runs every case of every command, and says which the guest took that the
 * device refuses.
 *
 * @param {RingApi} api
 * @param {Record<string, Case[]>} table
 */
function gate(api, table){
    assert.deepEqual(Object.keys(table).sort(), Object.keys(api.COMMANDS).sort(),
        'every command the ring carries has its cases, and only those');
    const { host, run } = machine();
    /** @type {string[]} */
    const wrong = [];
    /** @type {Set<string>} */
    const taken = new Set();
    for (const [name, cases] of Object.entries(table))
    {
        const shape = api.COMMANDS[name];
        const routine = commandCode(ROUTINE, TRAP,
            { ...shape, slot: api.commandSlot(name), mirror: api.mirrors[name] });
        for (const { label, args, data = [], caps, setup } of cases)
        {
            const device = api.device(caps);
            /** @type {Record<string, any>} */
            const made = {};
            setup?.(device, made);
            /** @type {Map<number, any>} */
            const pointers = new Map();
            const names = Object.keys(made);
            /** @type {Map<object, number>} */
            const containers = new Map();
            names.forEach((key, i)=>{
                const at = OBJECTS + i * 16;
                // An object's interface points at its block one word on; a
                // surface's at a block of its own with its description, as the
                // seam publishes one.
                /** @type {{ desc?: any }} */
                const held = {};
                const surface = typeof made[key].LockRect === 'function'
                    && typeof made[key].GetDesc === 'function'
                    && made[key].GetDesc(held) === D3D_OK && held.desc;
                const block = surface ? SURFACES + i * SURFACE.SIZE : BLOCK;
                if (surface)
                {
                    // And the texture it is a level of, numbered as the shadow numbers them.
                    const container = made[key].container;
                    if (container && !containers.has(container))
                    {
                        containers.set(container, containers.size + 1);
                    }
                    const { Format, Type, Usage, Pool, Width, Height } = held.desc;
                    host.writePhysical(block, new Uint8Array(new Uint32Array([0, Format, Type,
                        Usage, Pool, 0, 0, Width, Height,
                        container ? /** @type {number} */ (containers.get(container)) : 0]).buffer));
                }
                host.writePhysical(at + 4, new Uint8Array(u32(block)));
                pointers.set(at, made[key]);
            });
            /** @param {number | string} arg */
            const value = arg=>(typeof arg === 'number' ? arg >>> 0
                : arg === 'data' ? DATA : OBJECTS + names.indexOf(arg) * 16);
            host.writePhysical(DATA, new Uint8Array(new Uint32Array(data).buffer));
            const values = args.map(value);
            const state = device.ringState();
            const valid = renderStatesOf(device);
            const record = shape.self
                ? run(routine, values[0], values.slice(1), state, valid)
                : run(routine, DEVICE, values, state, valid);
            if (record === null)
            {
                continue;
            }
            taken.add(name);
            const objects = api.commandObjects(record, pointer=>pointers.get(pointer));
            api.runCommands(device, record, objects, (refused, hr)=>{
                wrong.push(`${refused} (${label}): D3D_OK in the guest, `
                    + `0x${(hr >>> 0).toString(16)} from the device`);
            });
        }
    }
    assert.deepEqual(wrong, [], 'a call the guest answered for is one the device takes');
    assert.deepEqual(Object.keys(table).filter(name=>!taken.has(name)), [],
        'each command has a case the guest takes, so its routine is exercised');
}

/** Direct3D 9: a HAL device with a D24S8 depth surface, as programs make one. */
const device9 = (caps = {})=>{
    const d3d = createDirect3D9(caps);
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT_DISCARD, backBufferCount: 1, backBufferWidth: 64,
        backBufferHeight: 64, backBufferFormat: D3DFMT_X8R8G8B8, enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT_D24S8,
    }, out), D3D_OK);
    return out.device;
};

/** Direct3D 8, the same. */
const device8 = (caps = {})=>{
    const d3d = createDirect3D8(caps);
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT_DISCARD, backBufferCount: 1, backBufferWidth: 64,
        backBufferHeight: 64, backBufferFormat: D3DFMT_X8R8G8B8, enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT_D24S8,
    }, out, 0), D3D_OK);
    return out.device;
};

/** @param {any} device @param {Record<string, any>} made */
const texture = (device, made)=>{
    /** @type {{ texture?: any }} */
    const out = {};
    assert.equal(device.CreateTexture(16, 16, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, out),
        D3D_OK);
    made.texture = out.texture;
};

/** A vertex buffer of position-and-colour vertices, bound as stream 0. @param {any} device */
const vertices9 = (device, /** @type {Record<string, any>} */ made)=>{
    /** @type {{ buffer?: any }} */
    const out = {};
    assert.equal(device.CreateVertexBuffer(1024, 0, FVF_XYZ_DIFFUSE, D3DPOOL_MANAGED, out),
        D3D_OK);
    made.vertices = out.buffer;
};

/** @param {any} device @param {Record<string, any>} made */
const indices = (device, made)=>{
    /** @type {{ buffer?: any }} */
    const out = {};
    assert.equal(device.CreateIndexBuffer(64, 0, D3DFMT_INDEX16, D3DPOOL_MANAGED, out), D3D_OK);
    made.indices = out.buffer;
};

/** A scene open and something to draw: stream 0, its format and indices. */
const drawable9 = (/** @type {any} */ device, /** @type {Record<string, any>} */ made)=>{
    vertices9(device, made);
    indices(device, made);
    assert.equal(device.SetStreamSource(0, made.vertices, 0, 16), D3D_OK);
    assert.equal(device.SetIndices(made.indices), D3D_OK);
    assert.equal(device.SetFVF(FVF_XYZ_DIFFUSE), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
};

const drawable8 = (/** @type {any} */ device, /** @type {Record<string, any>} */ made)=>{
    /** @type {{ buffer?: any }} */
    const out = {};
    assert.equal(device.CreateVertexBuffer(1024, 0, FVF_XYZ_DIFFUSE, D3DPOOL_MANAGED, out),
        D3D_OK);
    made.vertices = out.buffer;
    indices(device, made);
    assert.equal(device.SetStreamSource(0, made.vertices, 16), D3D_OK);
    assert.equal(device.SetIndices(made.indices, 0), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_XYZ_DIFFUSE), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
};

/** A device that records for one drawing elsewhere, as one in a graphics worker. */
const ELSEWHERE = { renderedElsewhere: true };

/** Three targets, two of one size, as a pass that shrinks its picture makes. */
const targets = (/** @type {any} */ device, /** @type {Record<string, any>} */ made)=>{
    for (const [name, size] of /** @type {[string, number][]} */ ([['big', 32], ['small', 16],
        ['other', 16]]))
    {
        /** @type {{ surface?: any }} */
        const out = {};
        assert.equal(device.CreateRenderTarget(size, size, D3DFMT_X8R8G8B8, 0, out), D3D_OK);
        made[name] = out.surface;
    }
};

/** A target of its own and a depth surface with no stencil, as an offscreen pass makes. */
const offscreen = (/** @type {any} */ device, /** @type {Record<string, any>} */ made)=>{
    /** @type {{ surface?: any }} */
    const target = {};
    assert.equal(device.CreateRenderTarget(16, 16, D3DFMT_X8R8G8B8, 0, target), D3D_OK);
    made.target = target.surface;
    /** @type {{ surface?: any }} */
    const stencil = {};
    assert.equal(device.CreateDepthStencilSurface(16, 16, D3DFMT_D24X8, stencil), D3D_OK);
    made.depth = stencil.surface;
};

const IDENTITY = floats([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const MATERIAL = floats(new Array(17).fill(0.5));
/** D3DLIGHT9/8: a directional light, and one of a type there is not. */
const LIGHT = [3, ...floats([1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    100, 0, 1, 0, 0, 0, 0])];
const NO_LIGHT = [0, ...LIGHT.slice(1)];
const VIEWPORT = [0, 0, 32, 32, 0, ONE];
/** Three position-and-colour vertices. */
const TRIANGLE = [...floats([0, 0, 0]), 0xffffffff, ...floats([1, 0, 0]), 0xffffffff,
    ...floats([0, 1, 0]), 0xffffffff];
const CONSTANTS = new Array(64).fill(ONE);

/**
 * What both versions' rings carry the same way (`SHARED_COMMANDS`), with how
 * each version makes something drawable.
 *
 * @param {(device: any, made: Record<string, any>) => void} drawable
 * @returns {Record<string, Case[]>}
 */
const shared = drawable=>({
    SetRenderState: [
        { label: 'a state the device has', args: [7, 1] },
        { label: 'a state past the block', args: [300, 1] },
        { label: 'a state the device refuses', args: [5, 1] },
    ],
    SetTransform: [
        { label: 'VIEW', args: [2, 'data'], data: IDENTITY },
        { label: 'WORLD1', args: [257, 'data'], data: IDENTITY },
        { label: 'a type below WORLD Direct3D 8 refuses', args: [0, 'data'], data: IDENTITY },
        { label: 'a type there is not', args: [24, 'data'], data: IDENTITY },
    ],
    SetTextureStageState: [
        { label: 'COLOROP', args: [0, 1, 4] },
        { label: 'a stage past the last', args: [8, 1, 4] },
        { label: 'a type there is not', args: [0, 40, 0] },
    ],
    SetMaterial: [{ label: 'a material', args: ['data'], data: MATERIAL }],
    SetViewport: [
        { label: 'within the target', args: ['data'], data: VIEWPORT },
        { label: 'past the target', args: ['data'], data: [0, 0, 128, 128, 0, ONE] },
        { label: 'no width', args: ['data'], data: [0, 0, 0, 32, 0, ONE] },
        { label: 'a negative corner', args: ['data'], data: [-4, 0, 8, 8, 0, ONE] },
    ],
    SetLight: [
        { label: 'a directional light', args: [0, 'data'], data: LIGHT },
        { label: 'a type there is not', args: [0, 'data'], data: NO_LIGHT },
    ],
    LightEnable: [{ label: 'on', args: [0, 1] }, { label: 'off', args: [3, 0] }],
    SetClipPlane: [
        { label: 'the first plane', args: [0, 'data'], data: floats([0, 1, 0, 0]) },
        { label: 'the first of six', args: [0, 'data'], data: floats([0, 1, 0, 0]),
            caps: { maxUserClipPlanes: 6 } },
        { label: 'the seventh of six', args: [6, 'data'], data: floats([0, 1, 0, 0]),
            caps: { maxUserClipPlanes: 6 } },
        { label: 'a plane past the last', args: [32, 'data'], data: floats([0, 1, 0, 0]) },
    ],
    DrawPrimitive: [
        { label: 'a triangle', args: [4, 0, 1], setup: drawable },
        { label: 'a type there is not', args: [0, 0, 1], setup: drawable },
        { label: 'no primitives', args: [4, 0, 0], setup: drawable },
        { label: 'outside a scene', args: [4, 0, 1] },
        { label: 'nothing to read the vertices with', args: [4, 0, 1],
            setup: device=>device.BeginScene() },
    ],
    BeginScene: [
        { label: 'a scene', args: [] },
        { label: 'a scene in a scene', args: [], setup: device=>device.BeginScene() },
    ],
    EndScene: [
        { label: 'the end of a scene', args: [], setup: device=>device.BeginScene() },
        { label: 'no scene to end', args: [] },
    ],
    Clear: [
        { label: 'the target', args: [0, 0, 1, 0, ONE, 0] },
        { label: 'two rectangles', args: [2, 'data', 1, 0, ONE, 0],
            data: [0, 0, 8, 8, 8, 8, 16, 16] },
        { label: 'target, depth and stencil', args: [0, 0, 7, 0, ONE, 0] },
        { label: 'stencil with a depth surface without it', args: [0, 0, 7, 0, ONE, 0],
            setup: (device, made)=>{
                offscreen(device, made);
                assert.equal(device.SetRenderTarget(...renderTarget(device, made)), D3D_OK);
            } },
        { label: 'the target of a target set on the host', args: [0, 0, 1, 0, ONE, 0],
            setup: (device, made)=>{
                offscreen(device, made);
                assert.equal(device.SetRenderTarget(...renderTarget(device, made)), D3D_OK);
            } },
        { label: 'no flags', args: [0, 0, 0, 0, ONE, 0] },
        { label: 'target and depth on a depth surface without stencil',
            args: [0, 0, 3, 0, ONE, 0],
            setup: (device, made)=>{
                offscreen(device, made);
                assert.equal(device.SetRenderTarget(...renderTarget(device, made)), D3D_OK);
            } },
        { label: 'depth with no depth surface', args: [0, 0, 2, 0, ONE, 0],
            setup: (device, made)=>{
                offscreen(device, made);
                delete made.depth;
                assert.equal(device.SetDepthStencilSurface
                    ? (device.SetDepthStencilSurface(null), device.SetRenderTarget(0, made.target))
                    : device.SetRenderTarget(made.target, null), D3D_OK);
            } },
        { label: 'a flag past stencil', args: [0, 0, 9, 0, ONE, 0] },
    ],
    DrawPrimitiveUP: [
        { label: 'a triangle', args: [4, 1, 'data', 16], data: TRIANGLE, setup: drawable },
        { label: 'outside a scene', args: [4, 1, 'data', 16], data: TRIANGLE },
        { label: 'a type there is not', args: [9, 1, 'data', 16], data: TRIANGLE,
            setup: drawable },
    ],
});

/**
 * SetRenderTarget's arguments for the offscreen target, which the two
 * versions name differently: an index and a surface, or a surface and its depth.
 *
 * @param {any} device @param {Record<string, any>} made
 */
const renderTarget = (device, made)=>(device.SetDepthStencilSurface
    ? (device.SetDepthStencilSurface(made.depth), [0, made.target])
    : [made.target, made.depth]);

test('Direct3D 9: every call the command ring answers for in the guest is one the device takes',
    ()=>{
        /** @param {any} device @param {Record<string, any>} made */
        const declaration = (device, made)=>{
            /** @type {{ declaration?: any }} */
            const out = {};
            const element = (/** @type {number} */ usage, /** @type {number} */ type,
                /** @type {number} */ offset)=>({ Stream: 0, Offset: offset, Type: type,
                Method: 0, Usage: usage, UsageIndex: 0 });
            assert.equal(device.CreateVertexDeclaration([
                element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0),
                element(D3DDECLUSAGE.COLOR, D3DDECLTYPE.D3DCOLOR, 12),
            ], out), D3D_OK);
            made.declaration = out.declaration;
        };
        /** @param {any} device @param {Record<string, any>} made */
        const stateBlock = (device, made)=>{
            /** @type {{ block?: any }} */
            const out = {};
            assert.equal(device.CreateStateBlock(D3DSBT_ALL, out), D3D_OK);
            made.block = out.block;
        };
        gate({ ...D3D9, mirrors: MIRRORS_9, device: device9 }, {
            ...shared(drawable9),
            SetRenderTarget: [
                { label: 'a target', args: [0, 'target'], setup: offscreen },
                { label: 'the second target', args: [1, 'target'], setup: offscreen },
                { label: 'none', args: [0, 0] },
                { label: 'a depth surface for a target', args: [0, 'depth'], setup: offscreen },
                { label: 'a texture level that is no target', args: [0, 'level'],
                    setup: (device, made)=>{
                        texture(device, made);
                        /** @type {{ surface?: any }} */
                        const out = {};
                        assert.equal(made.texture.GetSurfaceLevel(0, out), D3D_OK);
                        made.level = out.surface;
                    } },
            ],
            // A copy between two targets, made on the GPU where the device draws elsewhere.
            StretchRect: [
                { label: 'two targets, stretched', args: ['big', 0, 'small', 0, 2],
                    caps: ELSEWHERE, setup: targets },
                { label: 'two targets of one size', args: ['small', 0, 'other', 0, 0],
                    caps: ELSEWHERE, setup: targets },
                { label: 'a device drawing itself', args: ['big', 0, 'small', 0, 2],
                    setup: targets },
                { label: 'a rectangle', args: ['big', 'data', 'small', 0, 2], data: [0, 0, 8, 8],
                    caps: ELSEWHERE, setup: targets },
                { label: 'a filter past anisotropic', args: ['big', 0, 'small', 0, 4],
                    caps: ELSEWHERE, setup: targets },
                { label: 'the same surface', args: ['big', 0, 'big', 0, 2], caps: ELSEWHERE,
                    setup: targets },
                { label: 'a depth surface', args: ['depth', 0, 'target', 0, 0], caps: ELSEWHERE,
                    setup: offscreen },
                { label: 'two levels of one target texture', args: ['top', 0, 'level', 0, 2],
                    caps: ELSEWHERE, setup: (device, made)=>{
                        /** @type {{ texture?: any }} */
                        const out = {};
                        assert.equal(device.CreateTexture(16, 16, 2, D3DUSAGE_RENDERTARGET,
                            D3DFMT_X8R8G8B8, D3DPOOL_DEFAULT, out), D3D_OK);
                        /** @type {{ surface?: any }} */
                        const top = {};
                        const level = {};
                        assert.equal(out.texture.GetSurfaceLevel(0, top), D3D_OK);
                        assert.equal(out.texture.GetSurfaceLevel(1, level), D3D_OK);
                        made.top = top.surface;
                        made.level = /** @type {any} */ (level).surface;
                    } },
            ],
            SetDepthStencilSurface: [
                { label: 'a depth surface', args: ['depth'], setup: offscreen },
                { label: 'none', args: [0] },
                { label: 'a target for a depth surface', args: ['target'], setup: offscreen },
            ],
            SetTexture: [
                { label: 'a texture', args: [0, 'texture'], setup: texture },
                { label: 'none', args: [0, 0] },
                { label: 'a vertex sampler', args: [257, 'texture'], setup: texture },
                { label: 'a stage past the last', args: [16, 'texture'], setup: texture },
                { label: 'past the vertex samplers', args: [261, 'texture'], setup: texture },
            ],
            SetSamplerState: [
                { label: 'MAGFILTER', args: [0, 5, 2] },
                { label: 'a vertex sampler', args: [257, 5, 2] },
                { label: 'a sampler past the last', args: [16, 5, 2] },
                { label: 'a type there is not', args: [0, 20, 0] },
                { label: 'a type below the first', args: [0, 0, 0] },
                { label: 'a type past DMAPOFFSET', args: [0, 14, 0] },
            ],
            SetStreamSource: [
                { label: 'stream 0', args: [0, 'vertices', 0, 16], setup: vertices9 },
                { label: 'stream 0, part of a vertex in', args: [0, 'vertices', 24, 16],
                    setup: vertices9 },
                { label: 'stream 0, at an offset of no whole word past a vertex',
                    args: [0, 'vertices', 22, 16], setup: vertices9 },
                { label: 'none', args: [0, 0, 0, 0] },
                { label: 'a stream past the last', args: [16, 'vertices', 0, 16],
                    setup: vertices9 },
            ],
            SetIndices: [
                { label: 'indices', args: ['indices'], setup: indices },
                { label: 'none', args: [0] },
            ],
            SetVertexDeclaration: [
                { label: 'a declaration', args: ['declaration'], setup: declaration },
                { label: 'none', args: [0] },
            ],
            SetVertexShader: [{ label: 'none', args: [0] }],
            SetPixelShader: [{ label: 'none', args: [0] }],
            SetFVF: [
                { label: 'position and colour, taken before', args: [FVF_XYZ_DIFFUSE],
                    setup: device=>device.SetFVF(FVF_XYZ_DIFFUSE) },
                { label: 'position and colour, not seen yet', args: [FVF_XYZ_DIFFUSE] },
                { label: 'none', args: [0] },
                { label: 'bits that are no format', args: [0xffffffff] },
            ],
            SetScissorRect: [{ label: 'a rectangle', args: ['data'], data: [0, 0, 8, 8] }],
            SetSoftwareVertexProcessing: [
                { label: 'off', args: [0] },
                { label: 'on, on a hardware device', args: [1] },
            ],
            SetVertexShaderConstantF: [
                { label: 'four registers', args: [0, 'data', 4], data: CONSTANTS },
                { label: 'past the last register', args: [255, 'data', 2], data: CONSTANTS },
            ],
            SetVertexShaderConstantI: [
                { label: 'one register', args: [0, 'data', 1], data: CONSTANTS },
                { label: 'past the last register', args: [15, 'data', 2], data: CONSTANTS },
            ],
            SetVertexShaderConstantB: [
                { label: 'one register', args: [0, 'data', 1], data: CONSTANTS },
                { label: 'past the last register', args: [15, 'data', 2], data: CONSTANTS },
            ],
            SetPixelShaderConstantF: [
                { label: 'four registers', args: [0, 'data', 4], data: CONSTANTS },
                { label: 'past the last register', args: [223, 'data', 2], data: CONSTANTS },
            ],
            SetPixelShaderConstantI: [
                { label: 'one register', args: [0, 'data', 1], data: CONSTANTS },
                { label: 'past the last register', args: [15, 'data', 2], data: CONSTANTS },
            ],
            SetPixelShaderConstantB: [
                { label: 'one register', args: [0, 'data', 1], data: CONSTANTS },
                { label: 'past the last register', args: [15, 'data', 2], data: CONSTANTS },
            ],
            DrawIndexedPrimitive: [
                { label: 'a triangle', args: [4, 0, 0, 3, 0, 1], setup: drawable9 },
                { label: 'outside a scene', args: [4, 0, 0, 3, 0, 1] },
                { label: 'no primitives', args: [4, 0, 0, 3, 0, 0], setup: drawable9 },
                { label: 'no indices', args: [4, 0, 0, 3, 0, 1], setup: (device, made)=>{
                    drawable9(device, made);
                    assert.equal(device.SetIndices(null), D3D_OK);
                } },
                { label: 'a stream offset part of a vertex in', args: [4, 0, 0, 3, 0, 1],
                    setup: (device, made)=>{
                        drawable9(device, made);
                        assert.equal(device.SetStreamSource(0, made.vertices, 8, 16), D3D_OK);
                    } },
                { label: 'a stream offset of no whole word past a vertex',
                    args: [4, 0, 0, 3, 0, 1], setup: (device, made)=>{
                        drawable9(device, made);
                        assert.equal(device.SetStreamSource(0, made.vertices, 6, 16), D3D_OK);
                    } },
                { label: 'after a draw from the program\'s memory', args: [4, 0, 0, 3, 0, 1],
                    setup: (device, made)=>{
                        drawable9(device, made);
                        assert.equal(device.DrawPrimitiveUP(4, 1, new Uint8Array(48), 16),
                            D3D_OK);
                    } },
            ],
            'StateBlock.Capture': [{ label: 'a block', args: ['block'], setup: stateBlock }],
            'StateBlock.Apply': [{ label: 'a block', args: ['block'], setup: stateBlock }],
        });
    });

test('Direct3D 8: every call the command ring answers for in the guest is one the device takes',
    ()=>{
        gate({ ...D3D8_COMMANDS, mirrors: MIRRORS_8, device: device8 }, {
            ...shared(drawable8),
            SetStreamSource: [
                { label: 'stream 0', args: [0, 'vertices', 16], setup: (device, made)=>{
                    drawable8(device, made);
                } },
                { label: 'none', args: [0, 0, 0] },
                { label: 'a stream past the last', args: [16, 'vertices', 16],
                    setup: drawable8 },
            ],
            SetIndices: [
                { label: 'indices', args: ['indices', 0], setup: indices },
                { label: 'none', args: [0, 0] },
            ],
            SetTexture: [
                { label: 'a texture', args: [0, 'texture'], setup: texture },
                { label: 'none', args: [0, 0] },
                { label: 'a stage past the last', args: [8, 'texture'], setup: texture },
            ],
            SetVertexShader: [
                { label: 'a format', args: [FVF_XYZ_DIFFUSE] },
                { label: 'none', args: [0] },
                { label: 'a shader that is not there', args: [0x101] },
            ],
            SetPixelShader: [
                { label: 'none', args: [0] },
                { label: 'a shader that is not there', args: [0x101] },
            ],
            SetVertexShaderConstant: [
                { label: 'four registers', args: [0, 'data', 4], data: CONSTANTS },
                { label: 'past the last register', args: [95, 'data', 2], data: CONSTANTS },
            ],
            SetPixelShaderConstant: [
                { label: 'four registers', args: [0, 'data', 4], data: CONSTANTS },
                { label: 'past the last register', args: [7, 'data', 2], data: CONSTANTS },
            ],
            DrawIndexedPrimitive: [
                { label: 'a triangle', args: [4, 0, 3, 0, 1], setup: drawable8 },
                { label: 'outside a scene', args: [4, 0, 3, 0, 1] },
            ],
        });
    });

/**
 * Calls made one after another with no host entry between them: each routine
 * checks its call against what the routines before it kept in the block, so
 * the block must follow the device through them as the device itself goes.
 * Each step says whether the routine takes it; what they took is then made on
 * the device, which must take all of it.
 *
 * @param {RingApi} api
 * @param {(device: any, made: Record<string, any>) => void} setup
 * @param {[string, (number | string)[], 'ok' | 'trap', number[]?][]} steps
 */
function sequence(api, setup, steps){
    const { host, start, call } = machine();
    const device = api.device();
    /** @type {Record<string, any>} */
    const made = {};
    setup(device, made);
    const names = Object.keys(made);
    /** @type {Map<number, any>} */
    const pointers = new Map();
    names.forEach((key, i)=>{
        host.writePhysical(OBJECTS + i * 16 + 4, new Uint8Array(u32(BLOCK)));
        pointers.set(OBJECTS + i * 16, made[key]);
    });
    start(device.ringState(), renderStatesOf(device));
    /** @type {Uint8Array | null} */
    let ring = null;
    steps.forEach(([name, args, expected, data = []], step)=>{
        const at = DATA + step * 0x100;
        host.writePhysical(at, new Uint8Array(new Uint32Array(data).buffer));
        const values = args.map(arg=>(typeof arg === 'number' ? arg >>> 0
            : arg === 'data' ? at : OBJECTS + names.indexOf(arg) * 16));
        const routine = commandCode(ROUTINE, TRAP, { ...api.COMMANDS[name],
            slot: api.commandSlot(name), mirror: api.mirrors[name] });
        const record = call(routine, DEVICE, values);
        assert.equal(record === null ? 'trap' : 'ok', expected, `step ${step}, ${name}`);
        ring = record ?? ring;
    });
    /** @type {string[]} */
    const wrong = [];
    if (ring)
    {
        api.runCommands(device, ring, api.commandObjects(ring, pointer=>pointers.get(pointer)),
            (refused, hr)=>wrong.push(`${refused}: 0x${(hr >>> 0).toString(16)}`));
    }
    assert.deepEqual(wrong, [], 'the device takes every call the routines took');
}

test('Direct3D 9: the routines keep what a draw needs as the device does, call after call', ()=>{
    const api = { ...D3D9, mirrors: MIRRORS_9, device: device9 };
    /** @param {any} device @param {Record<string, any>} made */
    const buffers = (device, made)=>{
        vertices9(device, made);
        indices(device, made);
        // A format the host has seen taken, as one a program sets every frame is.
        assert.equal(device.SetFVF(FVF_XYZ_DIFFUSE), D3D_OK);
        assert.equal(device.SetFVF(0), D3D_OK);
    };
    sequence(api, buffers, [
        ['BeginScene', [], 'ok'],
        ['SetFVF', [FVF_XYZ_DIFFUSE], 'ok'],
        ['SetStreamSource', [0, 'vertices', 0, 16], 'ok'],
        ['SetIndices', ['indices'], 'ok'],
        ['DrawPrimitive', [4, 0, 1], 'ok'],
        ['DrawIndexedPrimitive', [4, 0, 0, 3, 0, 1], 'ok'],
        ['EndScene', [], 'ok'],
        ['DrawPrimitive', [4, 0, 1], 'trap'],
    ]);
    sequence(api, buffers, [
        ['BeginScene', [], 'ok'],
        ['BeginScene', [], 'trap'],
    ]);
    sequence(api, buffers, [
        ['BeginScene', [], 'ok'],
        ['SetFVF', [FVF_XYZ_DIFFUSE], 'ok'],
        ['SetStreamSource', [0, 'vertices', 8, 16], 'ok'],
        ['DrawPrimitive', [4, 0, 1], 'ok'],
        ['SetStreamSource', [0, 'vertices', 6, 16], 'ok'],
        ['DrawPrimitive', [4, 0, 1], 'trap'],
    ]);
    sequence(api, buffers, [
        ['BeginScene', [], 'ok'],
        ['SetStreamSource', [0, 'vertices', 0, 16], 'ok'],
        ['SetIndices', ['indices'], 'ok'],
        ['SetVertexDeclaration', [0], 'ok'],
        ['DrawPrimitive', [4, 0, 1], 'trap'],
    ]);
    sequence(api, buffers, [
        ['BeginScene', [], 'ok'],
        ['SetFVF', [FVF_XYZ_DIFFUSE], 'ok'],
        ['SetStreamSource', [0, 'vertices', 0, 16], 'ok'],
        ['SetIndices', ['indices'], 'ok'],
        ['DrawPrimitiveUP', [4, 1, 'data', 16], 'ok', TRIANGLE],
        ['DrawIndexedPrimitive', [4, 0, 0, 3, 0, 1], 'trap'],
    ]);
});

test('Direct3D 8: the routines keep what a draw needs as the device does, call after call', ()=>{
    const api = { ...D3D8_COMMANDS, mirrors: MIRRORS_8, device: device8 };
    /** @param {any} device @param {Record<string, any>} made */
    const buffers = (device, made)=>{
        /** @type {{ buffer?: any }} */
        const out = {};
        assert.equal(device.CreateVertexBuffer(1024, 0, FVF_XYZ_DIFFUSE, D3DPOOL_MANAGED, out),
            D3D_OK);
        made.vertices = out.buffer;
        assert.equal(device.SetVertexShader(0), D3D_OK);
    };
    sequence(api, buffers, [
        ['BeginScene', [], 'ok'],
        ['SetVertexShader', [FVF_XYZ_DIFFUSE], 'ok'],
        ['SetStreamSource', [0, 'vertices', 16], 'ok'],
        ['DrawPrimitive', [4, 0, 1], 'ok'],
        ['SetStreamSource', [0, 0, 0], 'ok'],
        ['DrawPrimitive', [4, 0, 1], 'trap'],
    ]);
    sequence(api, buffers, [
        ['BeginScene', [], 'ok'],
        ['SetVertexShader', [0], 'ok'],
        ['SetStreamSource', [0, 'vertices', 16], 'ok'],
        ['DrawPrimitive', [4, 0, 1], 'trap'],
    ]);
    sequence(api, buffers, [
        ['BeginScene', [], 'ok'],
        ['EndScene', [], 'ok'],
        ['EndScene', [], 'trap'],
    ]);
});
