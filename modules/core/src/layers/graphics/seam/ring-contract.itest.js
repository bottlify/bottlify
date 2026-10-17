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
import { SHADOW, SURFACE, VERTEX_BUFFER7, commandCode } from './shadow.js';
import { COMMAND_MIRRORS as MIRRORS_9 } from './d3d9.js';
import { COMMAND_MIRRORS as MIRRORS_8 } from './d3d8.js';
import * as D3D9 from '../d3d9/commands.js';
import { D3D8_COMMANDS } from '../d3d8/commands.js';
import { D3D7_COMMANDS } from '../d3d7/commands.js';
import { COMMAND_MIRRORS as MIRRORS_7 } from './d3d7.js';
import { createDirect3D7 } from '../d3d7/device.js';
import { DEVICE_IDS as DEVICE_IDS_7 } from '../d3d7/constants.js';
import { createDirectDraw } from '../ddraw/objects.js';
import {
    DDSCAPS_3DDEVICE, DDSCAPS_OFFSCREENPLAIN, DDSCAPS_TEXTURE, DDSCAPS_ZBUFFER, DDSCL_NORMAL,
    DDSD_CAPS, DDSD_HEIGHT, DDSD_WIDTH, DDSD_ZBUFFERBITDEPTH,
} from '../ddraw/constants.js';
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
        (state.strides ?? []).slice(0, SHADOW.FVF_STRIDE_PAIRS).forEach(([fvf, stride], index)=>{
            words[(SHADOW.FVF_STRIDES - SHADOW.DRAWABLE) / 4 + index * 2] = fvf;
            words[(SHADOW.FVF_STRIDES - SHADOW.DRAWABLE) / 4 + index * 2 + 1] = stride;
        });
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
 * The objects a case made, each at its interface in guest memory with its
 * block one word on: a surface's of its own with its description, and a
 * Direct3D 7 vertex buffer's with its lock and its vertices, as the seams
 * publish them; any other's is the device's block.
 *
 * @param {ReturnType<typeof machine>['host']} host @param {Record<string, any>} made
 * @returns {Map<number, any>} the objects by pointer
 */
function placeObjects(host, made){
    /** @type {Map<number, any>} */
    const pointers = new Map();
    /** @type {Map<object, number>} */
    const containers = new Map();
    Object.keys(made).forEach((key, i)=>{
        const at = OBJECTS + i * 16;
        /** @type {{ desc?: any }} */
        const held = {};
        const surface = typeof made[key].LockRect === 'function'
            && typeof made[key].GetDesc === 'function'
            && made[key].GetDesc(held) === D3D_OK && held.desc;
        const vertices = !surface && typeof made[key].numVertices === 'number'
            && typeof made[key].LockInPlace === 'function';
        const block = surface || vertices ? SURFACES + i * SURFACE.SIZE : BLOCK;
        if (vertices)
        {
            const words = new Uint32Array(VERTEX_BUFFER7.SIZE / 4);
            words[VERTEX_BUFFER7.LOCKED / 4] = made[key].locked ? 1 : 0;
            words[VERTEX_BUFFER7.VERTICES / 4] = made[key].numVertices;
            host.writePhysical(block, new Uint8Array(words.buffer));
        }
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
    return pointers;
}

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
            const names = Object.keys(made);
            const pointers = placeObjects(host, made);
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
            // A whole target onto another of its size, where the device draws elsewhere.
            CopyRects: [
                { label: 'two targets of one size', args: ['small', 0, 0, 'other', 0],
                    caps: ELSEWHERE, setup: targets },
                { label: 'two sizes', args: ['big', 0, 0, 'small', 0], caps: ELSEWHERE,
                    setup: targets },
                { label: 'a device drawing itself', args: ['small', 0, 0, 'other', 0],
                    setup: targets },
                { label: 'rectangles', args: ['small', 'data', 1, 'other', 'data'],
                    data: [0, 0, 8, 8], caps: ELSEWHERE, setup: targets },
                { label: 'the same surface', args: ['small', 0, 0, 'small', 0],
                    caps: ELSEWHERE, setup: targets },
                { label: 'a depth surface', args: ['depth', 0, 0, 'target', 0],
                    caps: ELSEWHERE, setup: offscreen },
                { label: 'two formats', args: ['small', 0, 0, 'argb', 0], caps: ELSEWHERE,
                    setup: (device, made)=>{
                        targets(device, made);
                        /** @type {{ surface?: any }} */
                        const out = {};
                        assert.equal(device.CreateRenderTarget(16, 16, D3DFMT_A8R8G8B8, 0, out),
                            D3D_OK);
                        made.argb = out.surface;
                    } },
            ],
            // Both targets at once: a null target keeps the bound one, the host's.
            SetRenderTarget: [
                { label: 'a target and a depth surface', args: ['target', 'depth'],
                    setup: offscreen },
                { label: 'a target and none', args: ['target', 0], setup: offscreen },
                { label: 'no target', args: [0, 'depth'], setup: offscreen },
                { label: 'a depth surface for a target', args: ['depth', 'depth'],
                    setup: offscreen },
                { label: 'a target for a depth surface', args: ['target', 'target'],
                    setup: offscreen },
                { label: 'a texture level for a target', args: ['level', 0],
                    setup: (device, made)=>{
                        texture(device, made);
                        /** @type {{ surface?: any }} */
                        const out = {};
                        assert.equal(made.texture.GetSurfaceLevel(0, out), D3D_OK);
                        made.level = out.surface;
                    } },
            ],
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
    const pointers = placeObjects(host, made);
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
    // What a target set says of the depth surface, which Clear's checks read,
    // and of the viewport, which SetViewport's do.
    /** @param {any} device @param {Record<string, any>} made */
    const depthTargets = (device, made)=>{
        offscreen(device, made);
        /** @type {{ surface?: any }} */
        const out = {};
        assert.equal(device.CreateDepthStencilSurface(16, 16, D3DFMT_D24S8, out), D3D_OK);
        made.stencil = out.surface;
    };
    sequence(api, depthTargets, [
        ['SetRenderTarget', ['target', 'depth'], 'ok'],
        ['Clear', [0, 0, 3, 0, ONE, 0], 'ok'],
        ['Clear', [0, 0, 7, 0, ONE, 0], 'trap'],
        ['SetRenderTarget', ['target', 'stencil'], 'ok'],
        ['Clear', [0, 0, 7, 0, ONE, 0], 'ok'],
        ['SetViewport', ['data'], 'ok', [0, 0, 16, 16, 0, ONE]],
        ['SetViewport', ['data'], 'trap', [0, 0, 64, 64, 0, ONE]],
        ['SetRenderTarget', ['target', 0], 'ok'],
        ['Clear', [0, 0, 2, 0, ONE, 0], 'trap'],
    ]);
});

/** Each Direct3D 7 device's DirectDraw object, for a case that makes surfaces. */
const roots7 = new WeakMap();
/** @param {any} device */
const device7Root = device=>roots7.get(device);

/** Direct3D 7: a HAL device on a target of its own, through a DirectDraw object. */
const device7 = ()=>{
    const root = createDirectDraw({ version: 7, screenWidth: 64, screenHeight: 64 });
    root.setCooperativeLevel(0x00010044, DDSCL_NORMAL);
    const target = root.createSurface({ flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT,
        caps: DDSCAPS_3DDEVICE | DDSCAPS_OFFSCREENPLAIN, width: 64, height: 64 });
    assert.equal(target.hr, D3D_OK);
    const made = createDirect3D7(root).createDevice(DEVICE_IDS_7.HAL, target.surface);
    assert.equal(made.hr, D3D_OK);
    roots7.set(made.device, root);
    return made.device;
};

test('Direct3D 7: every call the command ring answers for in the guest is one the device takes',
    ()=>{
        const common = shared(()=>{});
        gate({ ...D3D7_COMMANDS, mirrors: MIRRORS_7, device: device7 }, {
            SetRenderState: common.SetRenderState,
            // This version's own numbers: WORLD is 1 and WORLD1..3 4..6, and 256 is none.
            SetTransform: [
                { label: 'WORLD', args: [1, 'data'], data: IDENTITY },
                { label: 'VIEW', args: [2, 'data'], data: IDENTITY },
                { label: 'WORLD3', args: [6, 'data'], data: IDENTITY },
                { label: 'TEXTURE7', args: [23, 'data'], data: IDENTITY },
                { label: 'Direct3D 8\'s WORLD', args: [256, 'data'], data: IDENTITY },
                { label: 'a type below TEXTURE0', args: [7, 'data'], data: IDENTITY },
                { label: 'none', args: [0, 'data'], data: IDENTITY },
            ],
            SetTextureStageState: [
                ...common.SetTextureStageState,
                // Stored in its own numbering, read back in the program's.
                { label: 'MAGFILTER', args: [0, 16, 3] },
                { label: 'MIPFILTER', args: [1, 18, 0] },
                { label: 'past TEXTURETRANSFORMFLAGS', args: [0, 25, 0] },
            ],
            SetMaterial: common.SetMaterial,
            SetViewport: common.SetViewport,
            SetLight: common.SetLight,
            LightEnable: common.LightEnable,
            SetClipPlane: common.SetClipPlane,
            BeginScene: common.BeginScene,
            EndScene: common.EndScene,
            SetTexture: [
                { label: 'a texture', args: [0, 'texture'], setup: texture7 },
                { label: 'the last stage', args: [7, 'texture'], setup: texture7 },
                { label: 'none', args: [0, 0] },
                { label: 'a stage past the last', args: [8, 'texture'], setup: texture7 },
            ],
            // By pointer, so many vertices as whole primitives, of a format the
            // host has drawn with: its width is the block's.
            DrawPrimitive: [
                { label: 'a triangle', args: [4, FVF_TL, 'data', 3, 0], data: TL_TRIANGLE,
                    setup: drawnWith },
                { label: 'a strip of three', args: [5, FVF_TL, 'data', 3, 0], data: TL_TRIANGLE,
                    setup: drawnWith },
                { label: 'a point', args: [1, FVF_TL, 'data', 1, 0], data: TL_TRIANGLE,
                    setup: drawnWith },
                { label: 'a format not drawn with', args: [4, FVF_TL | 0x20, 'data', 3, 0],
                    data: [...TL_TRIANGLE, 0, 0, 0], setup: drawnWith },
                { label: 'four vertices of a list', args: [4, FVF_TL, 'data', 4, 0],
                    data: [...TL_TRIANGLE, ...TL_TRIANGLE.slice(0, 5)], setup: drawnWith },
                { label: 'three of a line list', args: [2, FVF_TL, 'data', 3, 0],
                    data: TL_TRIANGLE, setup: drawnWith },
                { label: 'a type there is not', args: [7, FVF_TL, 'data', 3, 0],
                    data: TL_TRIANGLE, setup: drawnWith },
                { label: 'outside a scene', args: [4, FVF_TL, 'data', 3, 0], data: TL_TRIANGLE,
                    setup: device=>{
                        drawnWith(device);
                        assert.equal(device.EndScene(), D3D_OK);
                    } },
            ],
            // A depth clear needs a depth buffer attached to the target.
            Clear: [
                { label: 'the target', args: [0, 0, 1, 0, ONE, 0] },
                { label: 'two rectangles', args: [2, 'data', 1, 0, ONE, 0],
                    data: [0, 0, 8, 8, 8, 8, 16, 16] },
                { label: 'depth without a depth buffer', args: [0, 0, 3, 0, ONE, 0] },
                { label: 'target, depth and stencil', args: [0, 0, 7, 0, ONE, 0],
                    setup: depth7 },
                { label: 'nothing to clear', args: [0, 0, 0, 0, ONE, 0] },
                { label: 'rectangles without a pointer', args: [2, 0, 1, 0, ONE, 0] },
            ],
            // From a buffer with a block, unlocked, holding the range drawn.
            DrawPrimitiveVB: [
                { label: 'a strip', args: [5, 'vb', 0, 4, 0], setup: buffer7 },
                { label: 'a list past the first vertex', args: [4, 'vb', 1, 3, 0],
                    setup: buffer7 },
                { label: 'without clipping', args: [4, 'vb', 0, 3, 4], setup: buffer7 },
                { label: 'past the last vertex', args: [4, 'vb', 2, 3, 0], setup: buffer7 },
                { label: 'a start that wraps', args: [4, 'vb', 0xfffffffe, 3, 0],
                    setup: buffer7 },
                { label: 'a locked buffer', args: [4, 'vb', 0, 3, 0], setup: lockedBuffer7 },
                { label: 'two of a list', args: [4, 'vb', 0, 2, 0], setup: buffer7 },
                { label: 'a type there is not', args: [7, 'vb', 0, 3, 0], setup: buffer7 },
                { label: 'no buffer', args: [4, 0, 0, 3, 0], setup: buffer7 },
                { label: 'outside a scene', args: [4, 'vb', 0, 3, 0],
                    setup: (device, made)=>{
                        buffer7(device, made);
                        assert.equal(device.EndScene(), D3D_OK);
                    } },
            ],
            // The same, and the indices: 16-bit, copied whole.
            DrawIndexedPrimitiveVB: [
                { label: 'a quad', args: [4, 'vb', 0, 4, 'data', 6, 0], data: QUAD_INDICES,
                    setup: buffer7 },
                { label: 'an odd count', args: [5, 'vb', 0, 4, 'data', 3, 0],
                    data: QUAD_INDICES, setup: buffer7 },
                { label: 'past the last vertex', args: [4, 'vb', 1, 4, 'data', 6, 0],
                    data: QUAD_INDICES, setup: buffer7 },
                { label: 'a locked buffer', args: [4, 'vb', 0, 4, 'data', 6, 0],
                    data: QUAD_INDICES, setup: lockedBuffer7 },
                { label: 'no indices', args: [4, 'vb', 0, 4, 0, 6, 0], setup: buffer7 },
                { label: 'two indices', args: [4, 'vb', 0, 4, 'data', 2, 0],
                    data: QUAD_INDICES, setup: buffer7 },
                { label: 'a type there is not', args: [0, 'vb', 0, 4, 'data', 6, 0],
                    data: QUAD_INDICES, setup: buffer7 },
                { label: 'outside a scene', args: [4, 'vb', 0, 4, 'data', 6, 0],
                    data: QUAD_INDICES, setup: (device, made)=>{
                        buffer7(device, made);
                        assert.equal(device.EndScene(), D3D_OK);
                    } },
            ],
        });
    });

/** A quad's six 16-bit indices, two to a dword. */
const QUAD_INDICES = [...new Uint32Array(Uint16Array.from([0, 1, 2, 2, 1, 3]).buffer)];

/** A scene, and a buffer of four transformed vertices. */
const buffer7 = (/** @type {any} */ device, /** @type {Record<string, any>} */ made)=>{
    const made7 = createDirect3D7(device7Root(device)).createVertexBuffer({ caps: 0,
        fvf: FVF_TL, numVertices: 4 });
    assert.equal(made7.hr, D3D_OK);
    made.vb = made7.buffer;
    assert.equal(device.BeginScene(), D3D_OK);
};
/** The same, locked. */
const lockedBuffer7 = (/** @type {any} */ device, /** @type {Record<string, any>} */ made)=>{
    buffer7(device, made);
    assert.equal(made.vb.Lock(0, {}), D3D_OK);
};
/** A depth buffer attached to the device's target. */
const depth7 = (/** @type {any} */ device)=>{
    const depth = device7Root(device).createSurface({
        flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_ZBUFFERBITDEPTH,
        caps: DDSCAPS_ZBUFFER, width: 64, height: 64, zBufferBitDepth: 16 });
    assert.equal(depth.hr, D3D_OK);
    /** @type {{ surface?: any }} */
    const held = {};
    assert.equal(device.GetRenderTarget(held), D3D_OK);
    assert.equal(held.surface.addAttachedSurface(depth.surface), D3D_OK);
};

/** A texture surface of the device's DirectDraw object. */
const texture7 = (/** @type {any} */ device, /** @type {Record<string, any>} */ made)=>{
    const surface = device7Root(device).createSurface({ flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT,
        caps: DDSCAPS_TEXTURE, width: 8, height: 8 });
    assert.equal(surface.hr, D3D_OK);
    made.texture = surface.surface;
};

/** Transformed, lit vertices: a position with its RHW and a colour, five words. */
const FVF_TL = 0x044;
/** Three of them. */
const TL_TRIANGLE = [...floats([0, 0, 0, 1]), 0xffffffff, ...floats([8, 0, 0, 1]), 0xffffffff,
    ...floats([0, 8, 0, 1]), 0xffffffff];
/** A scene, and a draw made on the host with the format, which the block learns the width of. */
const drawnWith = (/** @type {any} */ device)=>{
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitive(4, FVF_TL, new Uint8Array(new Uint32Array(TL_TRIANGLE)
        .buffer), 3), D3D_OK);
};

test('Direct3D 7: a draw by pointer carries the program\'s vertices, as wide as its format\'s'
    + ' entry in the block, whole', ()=>{
    const { host, run } = machine();
    const routine = commandCode(ROUTINE, TRAP, { ...D3D7_COMMANDS.COMMANDS.DrawPrimitive,
        slot: D3D7_COMMANDS.commandSlot('DrawPrimitive') });
    const device = device7();
    drawnWith(device);
    // Two formats drawn with, the second wider: each draw copies by its own.
    const WIDE = FVF_TL | 0x80;
    assert.equal(device.DrawPrimitive(4, WIDE, new Uint8Array(3 * 24), 3), D3D_OK);
    const state = device.ringState();
    assert.deepEqual(state.strides.slice(0, 2), [[WIDE, 24], [FVF_TL, 20]]);
    for (const [fvf, width] of [[FVF_TL, 20], [WIDE, 24]])
    {
        const vertices = Uint8Array.from({ length: 6 * width },
            (unused, i)=>(i * 7 + width) & 0xff);
        host.writePhysical(DATA, vertices);
        const record = run(routine, DEVICE, [4, fvf, DATA, 6, 0], state, renderStatesOf(device));
        assert.ok(record, `the draw of format 0x${fvf.toString(16)} is taken in the guest`);
        const words = new Uint32Array(record.buffer, record.byteOffset, record.byteLength >>> 2);
        assert.equal(words[1], 8 + 5 * 4 + 6 * width,
            'the record is the arguments and the vertices');
        // The pointer names the copy, just past the record's five arguments.
        assert.deepEqual([...words.subarray(2, 7)], [4, fvf, RING + 28, 6, 0]);
        assert.deepEqual([...record.subarray(28, 28 + 6 * width)], [...vertices],
            'every byte of every vertex');
    }
});
