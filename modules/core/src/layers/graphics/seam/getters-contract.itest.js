/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The getters that answer in the guest, as a gate: GetRenderState,
 * GetTransform, GetTextureStageState, GetViewport, GetSamplerState and
 * Direct3D 8's GetVertexShader and GetPixelShader read the device's block,
 * and a Direct3D 9 surface's GetDesc reads the surface's, where the setters'
 * command routines and the host's own changes keep what the device holds. A
 * program reads back what it set and goes on by the answer, so a getter in
 * the guest must answer what the device's own getter answers at that point of
 * the program, the calls the ring holds made up to there -- the HRESULT, and
 * every byte it writes or leaves alone.
 *
 * Two processes run one program on the real processor (cork) over the real
 * seams (`createGraphicsLibraries`): one with the guest code on, where the
 * device's block is the one a real `createShadow` writes and the host's
 * mirroring is the seam's own, and one with every call a trap -- what the
 * program gets with the guest code off. The programs are random sequences of
 * setters through the guest routines and through the host, resets, state
 * blocks captured and applied through both, render targets set and getters,
 * with arguments in range and at its edges; every answer the two processes
 * give is compared, and so is the whole of each getter's domain at the end.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import * as cork from '../../../../../cork/src/index.js';
import { createVtables } from '../../bridge/internal/vtable.js';
import { createGraphicsLibraries } from './exports.js';
import { COMMAND_RING_BYTES } from './shadow.js';
import { IID_IDirect3DDevice8 } from './iids.js';
import {
    IDIRECT3D8_SLOTS, IDIRECT3D9_SLOTS, IDIRECT3DDEVICE8_SLOTS, IDIRECT3DSURFACE8_SLOTS,
    IDIRECT3DTEXTURE8_SLOTS,
} from './vtables.js';
import {
    IDIRECT3DDEVICE9_SLOTS, IDIRECT3DSTATEBLOCK9_SLOTS, IDIRECT3DSURFACE9_SLOTS,
    IDIRECT3DTEXTURE9_SLOTS, IID_IDirect3DDevice9, IID_IDirect3DStateBlock9,
    IID_IDirect3DSurface9,
} from '../d3d9/interfaces.js';
import { createDirect3D8 } from '../d3d8/device.js';
import { createDirect3D9 } from '../d3d9/device.js';
import { loopbackDirect3D } from '../remote/loopback.js';

const ENTRY = 0x7000;
const PROGRAM = 0x8000;
/** A `hlt` per trap the bridge registers, four bytes apart. */
const TRAPS = 0x10000;
/** What a call reads through a pointer: a matrix, a viewport, present parameters. */
const DATA = 0x20000;
/** What a getter writes through its pointer, filled with `UNWRITTEN` before each call. */
const OUT = 0x22000;
const OUT_BYTES = 64;
/** Where an interface or a state block's handle is handed back. */
const KEPT = 0x22800;
const STACK = 0xf0000;
const HEAP = 0x100000;
const CODE = 0x2000000;
const HWND = 0x00010044;
const UNWRITTEN = 0xcd;

const D3D_OK = 0;
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_D24S8 = 75;
const D3DFMT_D24X8 = 77;
const D3DPOOL_MANAGED = 1;
const D3DCREATE_HARDWARE_VERTEXPROCESSING = 0x40;
const D3DDEVTYPE_HAL = 1;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {number[]} values  Floats as their dwords. */
const floats = values=>[...new Uint32Array(new Float32Array(values).buffer)];

/** @param {number} value */
const hex = value=>(value >>> 0).toString(16).padStart(8, '0');

/**
 * A version as a program reaches it: its library and entry point, its
 * interfaces' slots and identifiers, and how its device and present
 * parameters are laid out.
 *
 * @typedef {Object} Version
 * @property {string} dll @property {string} entry
 * @property {(services: any) => any} factory
 * @property {Record<string, [string, number][]>} slots  by kind of object
 * @property {Record<string, string>} iids  by kind of object, for its traps
 * @property {(width: number, height: number) => number[]} present
 * @property {boolean} nine  whether this is Direct3D 9
 */

/** @type {Version} */
const D3D9 = {
    dll: 'D3D9.dll',
    entry: 'Direct3DCreate9',
    factory: createDirect3D9,
    slots: {
        root: IDIRECT3D9_SLOTS, device: IDIRECT3DDEVICE9_SLOTS, surface: IDIRECT3DSURFACE9_SLOTS,
        texture: IDIRECT3DTEXTURE9_SLOTS, block: IDIRECT3DSTATEBLOCK9_SLOTS,
    },
    iids: {
        device: IID_IDirect3DDevice9, surface: IID_IDirect3DSurface9,
        block: IID_IDirect3DStateBlock9,
    },
    present: (width, height)=>[width, height, D3DFMT_X8R8G8B8, 1, 0, 0, 1, HWND, 1, 1,
        D3DFMT_D24S8, 0, 0, 0],
    nine: true,
};

/** @type {Version} */
const D3D8 = {
    dll: 'D3D8.dll',
    entry: 'Direct3DCreate8',
    factory: createDirect3D8,
    slots: {
        root: IDIRECT3D8_SLOTS, device: IDIRECT3DDEVICE8_SLOTS, surface: IDIRECT3DSURFACE8_SLOTS,
        texture: IDIRECT3DTEXTURE8_SLOTS,
    },
    iids: { device: IID_IDirect3DDevice8 },
    present: (width, height)=>[width, height, D3DFMT_X8R8G8B8, 1, 0, 1, HWND, 1, 1,
        D3DFMT_D24S8, 0, 0, 0],
    nine: false,
};

/**
 * How the process with the guest code on is put together: guest routines
 * kept as traps all the same (`guestTraps`), no room for the command ring,
 * or the device recorded and played as a graphics worker plays it.
 *
 * @typedef {{ guestCode: boolean, guestTraps?: string[], ringRoom?: boolean,
 *     recorded?: boolean }} Options
 */

/**
 * A process on the real processor with one version's library: the bridge's
 * vtables over its memory, each trap a `hlt` the run below answers the way
 * the bridge does -- the arguments off the stack, the handler, EAX and a
 * stdcall return.
 *
 * @param {Version} version @param {Options} options
 */
function machine(version, options){
    const host = createCorkHost({
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: ENTRY,
        initialStack: STACK, engine: cork, cork: { sliceMs: Infinity },
    });
    host.writePhysical(ENTRY, new Uint8Array(u32(PROGRAM)));
    /** @param {number} at @param {number} value */
    const writeU32 = (at, value)=>host.writePhysical(at, new Uint8Array(u32(value >>> 0)));
    const services = {
        /** @param {number} at @param {number} length */
        readMemory: (at, length)=>host.readPhysical(at, length).slice(),
        /** @param {number} at @param {number} length */
        windowMemory: (at, length)=>host.readPhysical(at, length),
        /** @param {number} at @param {Uint8Array} bytes */
        writeMemory: (at, bytes)=>host.writePhysical(at, bytes),
        /** @param {number} at */
        readU32: at=>host.readU32(at) >>> 0,
        writeU32,
    };
    let heap = HEAP;
    let code = CODE;
    /** @param {number} bytes */
    const allocate = bytes=>{
        if (options.ringRoom === false && bytes >= COMMAND_RING_BYTES)
        {
            return 0;
        }
        const at = heap;
        heap += (bytes + 15) & ~15;
        return at;
    };
    /** @param {number} bytes */
    const allocateCode = bytes=>{
        const at = code;
        code += (bytes + 15) & ~15;
        return at;
    };
    /** @type {Map<number, { name: string, fn: any }>} */
    const traps = new Map();
    /** @type {Map<string, number>} */
    const trapOf = new Map();
    /** How often each trap was reached, by its name. @type {Map<string, number>} */
    const reached = new Map();
    /**
     * How often each method was called through its vtable, by its trap's
     * name, and how often such a call went on to the trap.
     *
     * @type {Map<string, number>}
     */
    const made = new Map();
    /** @type {Map<string, number>} */
    const fellBack = new Map();
    const vtables = createVtables({
        memory: { readBytes: services.readMemory, writeBytes: services.writeMemory,
            readU32: services.readU32, writeU32 },
        register: (/** @type {string} */ name, /** @type {any} */ fn)=>{
            const at = TRAPS + traps.size * 4;
            host.writePhysical(at, new Uint8Array([0xf4]));
            traps.set(at, { name, fn });
            trapOf.set(name, at);
            return at;
        },
        heap: { allocate, allocateCode },
    });
    /**
     * What the seam and the device say was not so: a call the guest answered
     * for that the device refused when the ring was played among them.
     *
     * @type {string[]}
     */
    const divergences = [];
    /** @param {string} api @param {string} detail */
    const divergence = (api, detail)=>divergences.push(`${api}: ${detail}`);
    const libraries = createGraphicsLibraries({
        graphics: {
            create: ()=>(options.recorded
                ? loopbackDirect3D(version.factory, { divergence })
                : version.factory({ divergence })),
            available: ()=>false,
            adapter: ()=>({ vendor: 'nvidia', architecture: 'ampere', description: '' }),
        },
        only: [version.dll],
        memory: services,
        publishInterface: (/** @type {any} */ object, /** @type {string} */ id)=>
            vtables.publish(object, id),
        screen: ()=>({ width: 800, height: 600, bitsPerPixel: 32, displayWidth: 1280,
            displayHeight: 1024 }),
        windowClientSize: ()=>({ width: 640, height: 480 }),
        allocate,
        allocateCode,
        guestCode: options.guestCode,
        guestTraps: options.guestTraps,
        divergence,
        now: ()=>0,
    }).libraries;

    /**
     * Calls the code at `target` as a program does -- `push` each argument,
     * `push this`, `call` -- and runs until it returns, answering each trap
     * on the way.
     *
     * @param {number} target @param {number} self @param {number[]} args
     */
    const run = (target, self, args)=>{
        /** @type {number[]} */
        const bytes = [];
        for (const value of [...args].reverse())
        {
            bytes.push(0x68, ...u32(value));
        }
        bytes.push(0x68, ...u32(self));
        bytes.push(0xe8, ...u32((target - (PROGRAM + bytes.length + 5)) | 0), 0xf4);
        host.writePhysical(PROGRAM, new Uint8Array(bytes));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        for (;;)
        {
            host.runSlice(1 << 20);
            const at = host.readReg32('eip') >>> 0;
            if (at === PROGRAM + bytes.length)
            {
                assert.equal(host.readReg32('esp') >>> 0, STACK, 'the callee popped its arguments');
                return host.readReg32('eax') >>> 0;
            }
            if (!host.halted())
            {
                // A slice also ends when the translator has blocks to form.
                continue;
            }
            const trap = traps.get(at - 1);
            assert.ok(trap, `halted at ${hex(at)}, which is no trap`);
            const esp = host.readReg32('esp') >>> 0;
            const words = trap.fn.argBytes >>> 2;
            const given = Array.from({ length: words },
                (unused, i)=>host.readU32(esp + 4 + 4 * i) | 0);
            reached.set(trap.name, (reached.get(trap.name) ?? 0) + 1);
            const answer = trap.fn.handler(given);
            assert.ok(!(answer instanceof Promise), `${trap.name} answered later`);
            host.writeReg32('eax', answer >>> 0);
            host.writeReg32('esp', esp + 4 + 4 * words);
            host.writeReg32('eip', host.readU32(esp));
        }
    };

    /**
     * The objects the program holds, by the name the program gives them: a
     * Direct3D 8 state block's handle among them, as the number it is.
     *
     * @type {Map<string, { pointer: number, kind: string, refs: number }>}
     */
    const held = new Map();
    held.set('root', {
        pointer: libraries[version.dll][version.entry].handler([version.nine ? 32 : 220]) >>> 0,
        kind: 'root', refs: 1,
    });

    /**
     * Calls `name` on the object held as `object`, through its vtable or
     * through its trap -- the host's path -- and says what the program got:
     * the HRESULT and what was written through the getter's pointer. A
     * string argument names an object held (`@name`); an object not held
     * leaves the call unmade, which both processes say alike.
     *
     * @param {string} object @param {string} name @param {(number | string)[]} args
     * @param {{ host?: boolean, out?: number, keep?: string, kind?: string }} [how]
     *     `out` bytes are read back from OUT; `keep` holds what was handed
     *     back at KEPT under that name, as an object of `kind` ('token' for a
     *     handle)
     */
    const call = (object, name, args, how = {})=>{
        const entry = held.get(object);
        /** @type {number[]} */
        const values = [];
        for (const arg of args)
        {
            const value = typeof arg === 'number' ? arg : held.get(arg.slice(1))?.pointer;
            if (value === undefined)
            {
                return 'not held';
            }
            values.push(value >>> 0);
        }
        if (!entry)
        {
            return 'not held';
        }
        const index = version.slots[entry.kind].findIndex(([slot])=>slot === name);
        assert.ok(index >= 0, `${name} is a method of the ${entry.kind}`);
        host.writePhysical(OUT, new Uint8Array(OUT_BYTES).fill(UNWRITTEN));
        writeU32(KEPT, 0);
        const named = `${version.iids[entry.kind]}::${name}`;
        const target = how.host
            ? trapOf.get(named)
            : host.readU32(host.readU32(entry.pointer) + 4 * (3 + index)) >>> 0;
        assert.ok(target, `${name} has a trap`);
        const before = reached.get(named) ?? 0;
        const hr = run(/** @type {number} */ (target), entry.pointer, values);
        if (!how.host)
        {
            made.set(named, (made.get(named) ?? 0) + 1);
            if ((reached.get(named) ?? 0) > before)
            {
                fellBack.set(named, (fellBack.get(named) ?? 0) + 1);
            }
        }
        const written = how.out ? ` ${Buffer.from(host.readPhysical(OUT, how.out)).toString('hex')}`
            : '';
        if (how.keep && hr === D3D_OK)
        {
            const pointer = host.readU32(KEPT) >>> 0;
            const already = held.get(how.keep);
            if (pointer !== 0)
            {
                held.set(how.keep, { pointer, kind: how.kind ?? 'surface',
                    refs: (already?.pointer === pointer ? already.refs : 0) + 1 });
            }
        }
        return `${hex(hr)}${written}`;
    };

    /** Lets go of a reference to an object held. @param {string} object */
    const release = object=>{
        const entry = held.get(object);
        if (!entry || entry.kind === 'token')
        {
            return 'not held';
        }
        run(host.readU32(host.readU32(entry.pointer) + 8) >>> 0, entry.pointer, []);
        entry.refs--;
        if (entry.refs <= 0)
        {
            held.delete(object);
        }
        // The count answered is the counts' gate's; this one says only that it went.
        return 'released';
    };

    /** @param {number[]} words */
    const put = words=>host.writePhysical(DATA, new Uint8Array(new Uint32Array(words).buffer));

    return { call, release, put, held, divergences, made, fellBack, version };
}

/** @typedef {ReturnType<typeof machine>} Machine */

/**
 * One step of a program: what it is called in a report, and what it does --
 * the answers the program got, in order.
 *
 * @typedef {{ label: string, run: (m: Machine) => string | string[] }} Step
 */

/** A seeded generator, so a failing program can be run again. @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    const next = ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        /** @param {number} n */
        int: n=>Math.floor(next() * n),
        /** @template T @param {readonly T[]} values @returns {T} */
        pick: values=>values[Math.floor(next() * values.length)],
        /** @param {number} p */
        chance: p=>next() < p,
        u32: ()=>Math.floor(next() * 4294967296) >>> 0,
    };
}

/** @typedef {ReturnType<typeof random>} Random */

/** The render states each version's device answers for, read off a device of its own. */
const answered = (/** @type {Version} */ version)=>{
    const d3d = version.factory({});
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({ swapEffect: 1, backBufferCount: 1, backBufferWidth: 64,
        backBufferHeight: 64, backBufferFormat: D3DFMT_X8R8G8B8, enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT_D24S8 }, out, version.nine ? undefined : 0), D3D_OK);
    return Array.from({ length: 300 }, (unused, state)=>state)
        .filter(state=>out.device.GetRenderState(state, {}) === D3D_OK);
};

/** States past the block and the device: the edges a getter must leave to the host. */
const EDGE_STATES = [0, 1, 5, 6, 10, 11, 255, 256, 257, 300, 0x7fffffff, 0xffffffff];
const VALUES = [0, 1, 2, 3, 4, 7, 0xff, 0x100, 0x3f800000, 0x80000000, 0xffffffff];
/**
 * Transform types: VIEW, PROJECTION and the eight texture matrices, WORLD and
 * WORLD1..3, and the numbers about them a device refuses or the block has no
 * slot for.
 */
const TRANSFORMS = [2, 3, 16, 17, 18, 19, 20, 21, 22, 23, 256, 257, 258, 259];
const EDGE_TRANSFORMS = [0, 1, 4, 15, 24, 25, 255, 260, 511, 512, 0x80000000, 0xffffffff];
/** Samplers: sixteen pixel ones, the displacement map's and four vertex ones, and past them. */
const EDGE_SAMPLERS = [16, 255, 256, 257, 258, 259, 260, 261, 0xffffffff];
/** Float bit patterns a matrix or a depth range may hold: zero both ways, NaNs, infinities. */
const EDGE_FLOATS = [0x80000000, 0x7fc00000, 0x7fc00001, 0xffc00000, 0x7f800001, 0x7f800000,
    0xff800000, 0x00000001];

/** @param {Random} rng */
const value = rng=>(rng.chance(0.5) ? rng.pick(VALUES) : rng.u32());

/** D3DVSD_STREAM(0), D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3), D3DVSD_END(). */
const DECLARATION = [0x20000000, 0x40020000, 0xffffffff];
/** vs_1_1: dp4 oPos.x..w, v0, c0..c3 -- Wine's simple_vs. */
const VERTEX_SHADER = [0xfffe0101,
    0x00000009, 0xc0010000, 0x90e40000, 0xa0e40000, 0x00000009, 0xc0020000, 0x90e40000, 0xa0e40001,
    0x00000009, 0xc0040000, 0x90e40000, 0xa0e40002, 0x00000009, 0xc0080000, 0x90e40000, 0xa0e40003,
    0x0000ffff];
/** ps_1_1: def c1, tex t0, dp3, mul, mul -- Wine's simple_ps. */
const PIXEL_SHADER = [0xffff0101,
    0x00000051, 0xa00f0001, 0x3f800000, 0x00000000, 0x00000000, 0x00000000, 0x00000042, 0xb00f0000,
    0x00000008, 0x800f0000, 0xa0e40001, 0xa0e40000, 0x00000005, 0x800f0000, 0x90e40000, 0x80e40000,
    0x00000005, 0x800f0000, 0xb0e40000, 0x80e40000, 0x0000ffff];
/**
 * What Direct3D 8's SetVertexShader is given: vertex formats with a
 * position, without one and with bits no format has, and numbers no shader
 * was handed back as.
 */
const VERTEX_SHADER_VALUES = [0x002, 0x112, 0x142, 0x152, 0x1c4, 0x000, 0x100, 0x400, 0x401,
    0x80000001, 0xffffffff];

/** A signalling NaN: what a float's trip through a number makes quiet. */
const SIGNALLING = 0x7f800001;

/**
 * @param {Random} rng @param {number} edge  how likely a value is a pattern of `EDGE_FLOATS`
 * @param {boolean} [quiet]  no signalling NaN among them
 */
const matrix = (rng, edge, quiet = false)=>Array.from({ length: 16 }, ()=>{
    const pattern = rng.chance(edge) ? rng.pick(EDGE_FLOATS) : floats([rng.int(64) / 8 - 4])[0];
    return quiet && pattern === SIGNALLING ? 0x7fc00001 : pattern;
});

/** @param {Random} rng @param {boolean} quiet */
const viewport = (rng, quiet)=>{
    const depth = ()=>floats([rng.pick([0, 0.25, 0.5, 1, 1.5, -0.5])])[0];
    const edge = ()=>{
        const pattern = rng.pick(EDGE_FLOATS);
        return quiet && pattern === SIGNALLING ? 0x7fc00001 : pattern;
    };
    return [
        rng.chance(0.1) ? 0xfffffffc : rng.int(24),
        rng.chance(0.1) ? 0x80000000 : rng.int(24),
        rng.chance(0.1) ? 0 : 1 + rng.int(72),
        rng.chance(0.1) ? 0 : 1 + rng.int(72),
        rng.chance(0.05) ? edge() : depth(),
        rng.chance(0.05) ? edge() : depth(),
    ];
};

/**
 * The getters of a version, as steps: a pointer, or none (`OUT` or 0).
 *
 * @param {Version} version
 */
const getters = version=>({
    /** @param {number} state @param {boolean} [none] */
    renderState: (state, none)=>/** @type {Step} */ ({
        label: `GetRenderState(${hex(state)}${none ? ', NULL' : ''})`,
        run: m=>m.call('device', 'GetRenderState', [state, none ? 0 : OUT], { out: 4 }),
    }),
    /** @param {number} type @param {boolean} [none] */
    transform: (type, none)=>/** @type {Step} */ ({
        label: `GetTransform(${hex(type)}${none ? ', NULL' : ''})`,
        run: m=>m.call('device', 'GetTransform', [type, none ? 0 : OUT], { out: 64 }),
    }),
    /** @param {number} stage @param {number} type @param {boolean} [none] */
    stageState: (stage, type, none)=>/** @type {Step} */ ({
        label: `GetTextureStageState(${hex(stage)}, ${hex(type)}${none ? ', NULL' : ''})`,
        run: m=>m.call('device', 'GetTextureStageState', [stage, type, none ? 0 : OUT],
            { out: 4 }),
    }),
    /** @param {boolean} [none] */
    viewport: none=>/** @type {Step} */ ({
        label: `GetViewport(${none ? 'NULL' : ''})`,
        run: m=>m.call('device', 'GetViewport', [none ? 0 : OUT], { out: 24 }),
    }),
    /** @param {number} sampler @param {number} type @param {boolean} [none] */
    samplerState: (sampler, type, none)=>/** @type {Step} */ ({
        label: `GetSamplerState(${hex(sampler)}, ${hex(type)}${none ? ', NULL' : ''})`,
        run: m=>(version.nine
            ? m.call('device', 'GetSamplerState', [sampler, type, none ? 0 : OUT], { out: 4 })
            : 'none'),
    }),
    /** @param {'GetVertexShader' | 'GetPixelShader'} name @param {boolean} [none] */
    shader: (name, none)=>/** @type {Step} */ ({
        label: `${name}(${none ? 'NULL' : ''})`,
        run: m=>(version.nine ? 'none'
            : m.call('device', name, [none ? 0 : OUT], { out: 4 })),
    }),
    /** @param {string} surface @param {boolean} [none] */
    desc: (surface, none)=>/** @type {Step} */ ({
        label: `${surface}.GetDesc(${none ? 'NULL' : ''})`,
        run: m=>m.call(surface, 'GetDesc', [none ? 0 : OUT], { out: 32 }),
    }),
});

/** The surfaces a program may hold, by the name the steps give them. */
const SURFACES = ['back', 'current', 'depth', 'target', 'zbuffer', 'level'];

/**
 * Every getter over the whole of its domain, edges included: what the
 * process answers for each.
 *
 * @param {Version} version @param {number[]} states
 * @returns {Step}
 */
const sweep = (version, states)=>{
    const get = getters(version);
    /** @type {Step[]} */
    const steps = [
        ...[...new Set([...states, ...EDGE_STATES])].map(state=>get.renderState(state)),
        ...[...TRANSFORMS, ...EDGE_TRANSFORMS].map(type=>get.transform(type)),
        ...Array.from({ length: 9 * 34 }, (unused, i)=>get.stageState(Math.floor(i / 34), i % 34)),
        get.stageState(0, 0x101),
        get.stageState(0xffffffff, 1),
        get.viewport(),
        ...(version.nine
            ? [...Array.from({ length: 16 }, (unused, i)=>i), ...EDGE_SAMPLERS]
                .flatMap(sampler=>Array.from({ length: 17 }, (unused, type)=>
                    get.samplerState(sampler, type)))
            : []),
        ...(version.nine ? SURFACES.map(surface=>get.desc(surface))
            : [get.shader('GetVertexShader'), get.shader('GetPixelShader')]),
    ];
    return {
        label: 'every getter',
        run: m=>steps.map(step=>`${step.label} = ${step.run(m)}`),
    };
};

/**
 * What a program does before it plays: a device, a render target and a
 * depth surface of its own, a texture and one of its levels, the back
 * buffer, and a state block of everything.
 *
 * @param {Version} version
 * @returns {Step[]}
 */
const setup = version=>[
    { label: 'CreateDevice', run: m=>{
        m.put(version.present(64, 64));
        return m.call('root', 'CreateDevice', [0, D3DDEVTYPE_HAL, HWND,
            D3DCREATE_HARDWARE_VERTEXPROCESSING, DATA, KEPT], { keep: 'device', kind: 'device' });
    } },
    ...acquire(version, 'target'),
    ...acquire(version, 'zbuffer'),
    ...acquire(version, 'back'),
    { label: 'CreateTexture', run: m=>m.call('device', 'CreateTexture', version.nine
        ? [16, 16, 0, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, KEPT, 0]
        : [16, 16, 0, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, KEPT],
    { keep: 'texture', kind: 'texture' }) },
    ...acquire(version, 'level'),
    stateBlock(version, 'all', 1),
];

/**
 * The call that hands a program a surface, by the name the steps give it.
 *
 * @param {Version} version @param {string} surface
 * @returns {Step[]}
 */
function acquire(version, surface){
    const keep = { keep: surface, kind: 'surface' };
    /** @type {Record<string, (m: Machine) => string>} */
    const ways = version.nine
        ? {
            back: m=>m.call('device', 'GetBackBuffer', [0, 0, 0, KEPT], keep),
            current: m=>m.call('device', 'GetRenderTarget', [0, KEPT], keep),
            depth: m=>m.call('device', 'GetDepthStencilSurface', [KEPT], keep),
            target: m=>m.call('device', 'CreateRenderTarget',
                [32, 16, D3DFMT_X8R8G8B8, 0, 0, 0, KEPT, 0], keep),
            zbuffer: m=>m.call('device', 'CreateDepthStencilSurface',
                [32, 16, D3DFMT_D24X8, 0, 0, 0, KEPT, 0], keep),
            level: m=>m.call('texture', 'GetSurfaceLevel', [1, KEPT], keep),
        }
        : {
            back: m=>m.call('device', 'GetBackBuffer', [0, 0, KEPT], keep),
            current: m=>m.call('device', 'GetRenderTarget', [KEPT], keep),
            depth: m=>m.call('device', 'GetDepthStencilSurface', [KEPT], keep),
            target: m=>m.call('device', 'CreateRenderTarget',
                [32, 16, D3DFMT_X8R8G8B8, 0, 0, KEPT], keep),
            zbuffer: m=>m.call('device', 'CreateDepthStencilSurface',
                [32, 16, D3DFMT_D24X8, 0, KEPT], keep),
            level: m=>m.call('texture', 'GetSurfaceLevel', [1, KEPT], keep),
        };
    return [{ label: `acquire ${surface}`, run: ways[surface] }];
}

/**
 * A state block of a type, made on the host: an interface in Direct3D 9, a
 * handle in Direct3D 8.
 *
 * @param {Version} version @param {string} name @param {number} type
 * @returns {Step}
 */
function stateBlock(version, name, type){
    return {
        label: `CreateStateBlock(${type}) as ${name}`,
        run: m=>m.call('device', 'CreateStateBlock', [type, KEPT],
            { keep: name, kind: version.nine ? 'block' : 'token' }),
    };
}

/**
 * The calls a random program is made of, each a step from the generator.
 * `skip` names the kinds of step left out of it.
 *
 * @param {Version} version @param {number[]} states @param {Random} rng
 * @param {ReadonlySet<string>} skip
 * @returns {Step}
 */
function randomStep(version, states, rng, skip){
    const get = getters(version);
    /** @param {string} kind */
    const through = kind=>(rng.chance(0.2) && !skip.has(`${kind} host`) ? { host: true } : {});
    const state = ()=>(rng.chance(0.85) ? rng.pick(states) : rng.pick(EDGE_STATES));
    const transform = ()=>(rng.chance(0.85) ? rng.pick(TRANSFORMS) : rng.pick(EDGE_TRANSFORMS));
    const stage = ()=>(rng.chance(0.9) ? rng.int(8) : rng.pick([8, 16, 0xffffffff]));
    const stageType = ()=>(rng.chance(0.95) ? rng.int(34) : rng.pick([0x101, 0xffffffff]));
    const sampler = ()=>(rng.chance(0.85) ? rng.int(16) : rng.pick(EDGE_SAMPLERS));
    const samplerType = ()=>(rng.chance(0.95) ? rng.int(17) : rng.pick([0x101, 0xffffffff]));
    /** A sampler and a type the device takes. */
    const taken = ()=>[rng.chance(0.85) ? rng.int(16) : 256 + rng.int(5), 1 + rng.int(13)];
    const none = ()=>rng.chance(0.05);
    const blocks = ['all', 'pixel', 'vertex', 'recorded'];
    /** @type {[string, number, () => Step][]} */
    const kinds = [
        ['SetRenderState', 14, ()=>{
            const at = skip.has('SetRenderState edge') ? rng.pick(states) : state();
            const set = value(rng);
            const how = through('SetRenderState');
            return { label: `SetRenderState(${hex(at)}, ${hex(set)})${how.host ? ' host' : ''}`,
                run: m=>m.call('device', 'SetRenderState', [at, set], how) };
        }],
        ['GetRenderState', 14, ()=>get.renderState(state(), none())],
        ['SetTransform', 8, ()=>{
            const type = skip.has('SetTransform edge') ? rng.pick(TRANSFORMS) : transform();
            const words = matrix(rng, 0.02, skip.has('signalling NaN matrix'));
            const how = through('SetTransform');
            const pointer = rng.chance(0.03) ? 0 : DATA;
            return { label: `SetTransform(${hex(type)}, ${pointer ? words.map(hex).join(' ')
                : 'NULL'})${how.host ? ' host' : ''}`,
            run: m=>{
                m.put(words);
                return m.call('device', 'SetTransform', [type, pointer], how);
            } };
        }],
        ['MultiplyTransform', 2, ()=>{
            const type = transform();
            const words = matrix(rng, 0);
            return { label: `MultiplyTransform(${hex(type)}, ${words.map(hex).join(' ')})`,
                run: m=>{
                    m.put(words);
                    return m.call('device', 'MultiplyTransform', [type, DATA]);
                } };
        }],
        ['GetTransform', 8, ()=>get.transform(transform(), none())],
        ['SetTextureStageState', 10, ()=>{
            const at = stage();
            const type = stageType();
            const set = value(rng);
            const how = through('SetTextureStageState');
            return { label: `SetTextureStageState(${hex(at)}, ${hex(type)}, ${hex(set)})`
                + `${how.host ? ' host' : ''}`,
            run: m=>m.call('device', 'SetTextureStageState', [at, type, set], how) };
        }],
        ['GetTextureStageState', 10, ()=>get.stageState(stage(), stageType(), none())],
        ['SetSamplerState', version.nine ? 10 : 0, ()=>{
            const [at, type] = skip.has('SetSamplerState edge') ? taken()
                : [sampler(), samplerType()];
            const set = value(rng);
            const how = through('SetSamplerState');
            return { label: `SetSamplerState(${hex(at)}, ${hex(type)}, ${hex(set)})`
                + `${how.host ? ' host' : ''}`,
            run: m=>m.call('device', 'SetSamplerState', [at, type, set], how) };
        }],
        ['GetSamplerState', version.nine ? 10 : 0, ()=>get.samplerState(sampler(), samplerType(),
            none())],
        ['SetViewport', 6, ()=>{
            const words = viewport(rng, skip.has('signalling NaN viewport'));
            const how = through('SetViewport');
            const pointer = rng.chance(0.03) ? 0 : DATA;
            return { label: `SetViewport(${pointer ? words.map(hex).join(' ') : 'NULL'})`
                + `${how.host ? ' host' : ''}`,
            run: m=>{
                m.put(words);
                return m.call('device', 'SetViewport', [pointer], how);
            } };
        }],
        ['GetViewport', 6, ()=>get.viewport(none())],
        ['GetDesc', version.nine ? 4 : 0, ()=>get.desc(rng.pick(SURFACES), none())],
        ['acquire', 3, ()=>acquire(version, rng.pick(SURFACES))[0]],
        ['release', 2, ()=>{
            const surface = rng.pick(SURFACES);
            return { label: `${surface}.Release`, run: m=>m.release(surface) };
        }],
        ['SetRenderTarget', 3, ()=>{
            const target = rng.pick(['@target', '@back', '@current', 0]);
            const depth = rng.pick(['@zbuffer', '@depth', 0]);
            const index = rng.chance(0.85) ? 0 : rng.pick([1, 3, 4]);
            return { label: `SetRenderTarget(${index}, ${target}, ${depth})`,
                run: m=>(version.nine
                    ? [m.call('device', 'SetRenderTarget', [index, target]),
                        m.call('device', 'SetDepthStencilSurface', [depth])]
                    : m.call('device', 'SetRenderTarget', [target, depth])) };
        }],
        ['Reset', 2, ()=>{
            const [width, height] = rng.pick([[64, 64], [32, 48], [48, 32]]);
            const bare = rng.chance(0.7);
            return { label: `Reset(${width}x${height})${bare ? ', every surface released' : ''}`,
                run: m=>{
                    const answers = [];
                    if (skip.has('Reset recording'))
                    {
                        answers.push(m.call('device', 'EndStateBlock', [KEPT],
                            { keep: 'recorded', kind: version.nine ? 'block' : 'token' }));
                    }
                    if (bare)
                    {
                        for (const surface of SURFACES)
                        {
                            while (m.held.has(surface))
                            {
                                answers.push(m.release(surface));
                            }
                        }
                    }
                    m.put(version.present(width, height));
                    answers.push(m.call('device', 'Reset', [DATA]));
                    return answers;
                } };
        }],
        ['CreateVertexShader', version.nine ? 0 : 1, ()=>({ label: 'CreateVertexShader as vs',
            run: m=>{
                m.put([...DECLARATION, ...VERTEX_SHADER]);
                return m.call('device', 'CreateVertexShader',
                    [DATA, DATA + 4 * DECLARATION.length, KEPT, 0], { keep: 'vs', kind: 'token' });
            } })],
        ['CreatePixelShader', version.nine ? 0 : 1, ()=>({ label: 'CreatePixelShader as ps',
            run: m=>{
                m.put(PIXEL_SHADER);
                return m.call('device', 'CreatePixelShader', [DATA, KEPT],
                    { keep: 'ps', kind: 'token' });
            } })],
        ['SetVertexShader', version.nine ? 0 : 6, ()=>{
            const set = rng.chance(0.4) ? '@vs' : rng.chance(0.9) ? rng.pick(VERTEX_SHADER_VALUES)
                : rng.u32();
            const how = through('SetVertexShader');
            return { label: `SetVertexShader(${typeof set === 'string' ? set : hex(set)})`
                + `${how.host ? ' host' : ''}`,
            run: m=>m.call('device', 'SetVertexShader', [set], how) };
        }],
        ['SetPixelShader', version.nine ? 0 : 5, ()=>{
            const set = rng.chance(0.5) ? '@ps' : rng.chance(0.7) ? 0 : rng.u32();
            const how = through('SetPixelShader');
            return { label: `SetPixelShader(${typeof set === 'string' ? set : hex(set)})`
                + `${how.host ? ' host' : ''}`,
            run: m=>m.call('device', 'SetPixelShader', [set], how) };
        }],
        ['GetVertexShader', version.nine ? 0 : 6, ()=>get.shader('GetVertexShader', none())],
        ['GetPixelShader', version.nine ? 0 : 6, ()=>get.shader('GetPixelShader', none())],
        ['DeleteShader', version.nine ? 0 : 1, ()=>{
            const pixel = rng.chance(0.5);
            return { label: pixel ? 'DeletePixelShader(@ps)' : 'DeleteVertexShader(@vs)',
                run: m=>(pixel ? m.call('device', 'DeletePixelShader', ['@ps'])
                    : m.call('device', 'DeleteVertexShader', ['@vs'])) };
        }],
        ['CreateStateBlock', 2, ()=>{
            const type = rng.pick([1, 2, 3, 0, 4]);
            return stateBlock(version, ['all', 'all', 'pixel', 'vertex', 'none'][type], type);
        }],
        ['BeginStateBlock', 1, ()=>({ label: 'BeginStateBlock',
            run: m=>m.call('device', 'BeginStateBlock', []) })],
        ['EndStateBlock', 3, ()=>({ label: 'EndStateBlock as recorded',
            run: m=>m.call('device', 'EndStateBlock', [KEPT],
                { keep: 'recorded', kind: version.nine ? 'block' : 'token' }) })],
        ['Capture', 3, ()=>{
            const block = rng.pick(blocks);
            const how = through('Capture');
            return { label: `${block}.Capture${how.host ? ' host' : ''}`,
                run: m=>(version.nine
                    ? m.call(block, 'Capture', [], how)
                    : m.call('device', 'CaptureStateBlock', [`@${block}`])) };
        }],
        ['Apply', 4, ()=>{
            const block = rng.pick(blocks);
            const how = through('Apply');
            return { label: `${block}.Apply${how.host ? ' host' : ''}`,
                run: m=>(version.nine
                    ? m.call(block, 'Apply', [], how)
                    : m.call('device', 'ApplyStateBlock', [`@${block}`])) };
        }],
        ['burst', 1, ()=>{
            const type = rng.pick([2, 256, 257]);
            const seed = rng.u32();
            return { label: `SetTransform(${hex(type)}) past the ring's end, then GetTransform`,
                run: m=>{
                    // More than the ring holds without a host entry between:
                    // the last ones find no room and are the host's.
                    const count = Math.ceil(COMMAND_RING_BYTES / 80) + 8;
                    const local = random(seed);
                    for (let i = 0; i < count; i++)
                    {
                        m.put(matrix(local, 0));
                        m.call('device', 'SetTransform', [type, DATA]);
                    }
                    return m.call('device', 'GetTransform', [type, OUT], { out: 64 });
                } };
        }],
    ];
    const live = kinds.filter(([kind, weight])=>weight > 0 && !skip.has(kind));
    const total = live.reduce((sum, [, weight])=>sum + weight, 0);
    let pick = rng.int(total);
    for (const [, weight, make] of live)
    {
        if (pick < weight)
        {
            return make();
        }
        pick -= weight;
    }
    throw new Error('unreachable');
}

/**
 * A program: the setup, `length` random steps, and every getter at the end.
 *
 * @param {Version} version @param {number[]} states @param {number} seed
 * @param {number} length @param {ReadonlySet<string>} [skip]
 * @returns {Step[]}
 */
function program(version, states, seed, length, skip = new Set()){
    const rng = random(seed);
    return [
        ...setup(version),
        ...Array.from({ length }, ()=>randomStep(version, states, rng, skip)),
        sweep(version, states),
    ];
}

/**
 * Runs a program on a process with the guest code as `options` say and on
 * one with every call a trap, and says where they answered apart: the first
 * few differences, each with its step, and the calls the guest answered for
 * that the device refused when the ring was played.
 *
 * @param {Version} version @param {Options} options @param {Step[]} steps
 */
function differences(version, options, steps){
    const guest = machine(version, options);
    const plain = machine(version, { guestCode: false });
    /** @type {string[]} */
    const found = [];
    /** @param {Step} step @param {Machine} m */
    const answers = (step, m)=>{
        try
        {
            return [step.run(m)].flat();
        }
        catch (e){
            // A step the object model throws on is answered alike by both, or not.
            return [`threw ${e instanceof Error ? e.message : e}`];
        }
    };
    steps.forEach((step, index)=>{
        const ours = answers(step, guest);
        const theirs = answers(step, plain);
        ours.forEach((answer, i)=>{
            if (answer !== theirs[i] && found.length < 8)
            {
                found.push(`step ${index}, ${step.label}: guest ${answer}, every call a trap `
                    + `${theirs[i]}`);
            }
        });
    });
    // Every refusal is reported (`refusals.js`), and a program refused alike
    // down both paths is told so alike: only what the guest path alone said counts.
    const said = [...plain.divergences];
    const divergences = guest.divergences.filter(line=>{
        const at = said.indexOf(line);
        if (at < 0)
        {
            return true;
        }
        said.splice(at, 1);
        return false;
    });
    return { found, divergences, guest, plain };
}

/**
 * The gate over many programs, and what it covered: how often each method
 * was called through its vtable, and how often it reached its trap.
 *
 * @param {Version} version @param {Options} options @param {number[]} seeds
 * @param {number} length @param {ReadonlySet<string>} [skip]
 */
function gate(version, options, seeds, length, skip){
    const states = answered(version);
    /** @type {string[]} */
    const wrong = [];
    /** @type {Map<string, number>} */
    const made = new Map();
    /** @type {Map<string, number>} */
    const fellBack = new Map();
    /** @param {Map<string, number>} into @param {Map<string, number>} from */
    const add = (into, from)=>from.forEach((count, name)=>into.set(name,
        (into.get(name) ?? 0) + count));
    for (const seed of seeds)
    {
        const { found, divergences: refused, guest } = differences(version, options,
            program(version, states, seed, length, skip));
        wrong.push(...found.map(line=>`seed ${seed}: ${line}`),
            ...refused.map(line=>`seed ${seed}: refused when played: ${line}`));
        add(made, guest.made);
        add(fellBack, guest.fellBack);
    }
    /**
     * How often `name` answered in the guest, and how often it went to the
     * host, through its vtable.
     *
     * @param {string} kind @param {string} name
     */
    const split = (kind, name)=>{
        const named = `${version.iids[kind]}::${name}`;
        const host = fellBack.get(named) ?? 0;
        return { guest: (made.get(named) ?? 0) - host, host };
    };
    return { wrong, split };
}

/**
 * What the gate's programs leave out: the kinds of step that meet a
 * divergence a todo test below holds. Each goes when its divergence is fixed.
 */
const KNOWN = new Set();

const SEEDS = Array.from({ length: 12 }, (unused, i)=>1 + i);
const LENGTH = 300;

/**
 * Asserts the gate found nothing, and that it reached what it is for: each
 * getter answered in the guest and went to the host, and each setter whose
 * routine keeps the block took calls in the ring.
 *
 * @param {Version} version @param {ReturnType<typeof gate>} result
 */
function passed(version, { wrong, split }){
    assert.deepEqual(wrong, [], 'the guest answers what every call a trap answers');
    const read = ['GetRenderState', 'GetTransform', 'GetTextureStageState', 'GetViewport',
        ...(version.nine ? ['GetSamplerState'] : ['GetVertexShader', 'GetPixelShader'])];
    for (const name of read)
    {
        const { guest, host } = split('device', name);
        assert.ok(guest > 50 && host > 0, `${name}: ${guest} in the guest, ${host} on the host`);
    }
    if (version.nine)
    {
        const { guest } = split('surface', 'GetDesc');
        assert.ok(guest > 10, `GetDesc: ${guest} in the guest`);
        for (const name of ['Capture', 'Apply'])
        {
            assert.ok(split('block', name).guest > 10, `${name} taken in the ring`);
        }
    }
    const setters = ['SetRenderState', 'SetTransform', 'SetTextureStageState', 'SetViewport',
        ...(version.nine ? ['SetSamplerState'] : ['SetVertexShader', 'SetPixelShader'])];
    for (const name of setters)
    {
        assert.ok(split('device', name).guest > 10, `${name} taken in the ring`);
    }
}

test('Direct3D 9: a getter answered in the guest answers what the device answers', ()=>{
    passed(D3D9, gate(D3D9, { guestCode: true }, SEEDS, LENGTH, KNOWN));
});

test('Direct3D 8: a getter answered in the guest answers what the device answers', ()=>{
    passed(D3D8, gate(D3D8, { guestCode: true }, SEEDS, LENGTH, KNOWN));
});

test('a device recorded for a graphics worker answers its getters as the device does', ()=>{
    // The recorded device answers plain getters on the program's side and the
    // shadow mirrors through it: what it answers must be what a device the
    // program held itself would.
    for (const version of [D3D9, D3D8])
    {
        passed(version, gate(version, { guestCode: true, recorded: true }, SEEDS.slice(0, 6),
            LENGTH, KNOWN));
    }
});

/**
 * A program written out rather than drawn: the setup, then `steps`. What the
 * two processes answered apart, and what the device refused that the guest
 * had answered for.
 *
 * @param {Version} version @param {Options} options @param {Step[]} steps
 */
const scripted = (version, options, steps)=>{
    const { found, divergences: refused } = differences(version, options,
        [...setup(version), ...steps]);
    return [...found, ...refused.map(line=>`refused when played: ${line}`)];
};

/** @param {string} label @param {(m: Machine) => string | string[]} run @returns {Step} */
const step = (label, run)=>({ label, run });

const D3DRS_CULLMODE = 22;
const D3DTS_VIEW = 2;
const D3DTSS_COLOROP = 1;
const SCALE = floats([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1]);

/**
 * A render state, a transform and a stage state set, then read back: the
 * calls through the vtable, wherever the guest's routines send them.
 *
 * @param {Version} version
 * @returns {Step[]}
 */
const setAndRead = version=>{
    const get = getters(version);
    return [
        step('SetRenderState(CULLMODE, NONE)', m=>m.call('device', 'SetRenderState',
            [D3DRS_CULLMODE, 1])),
        get.renderState(D3DRS_CULLMODE),
        step('SetTransform(VIEW, a scale)', m=>{
            m.put(SCALE);
            return m.call('device', 'SetTransform', [D3DTS_VIEW, DATA]);
        }),
        get.transform(D3DTS_VIEW),
        step('SetTextureStageState(0, COLOROP, SELECTARG2)', m=>m.call('device',
            'SetTextureStageState', [0, D3DTSS_COLOROP, 3])),
        get.stageState(0, D3DTSS_COLOROP),
    ];
};

test('a setter kept as a trap is one the getters in the guest read', ()=>{
    for (const version of [D3D9, D3D8])
    {
        assert.deepEqual(scripted(version, { guestCode: true, guestTraps: ['ring'] },
            setAndRead(version)), [], version.dll);
    }
});

test('with no room for a command ring, the getters in the guest read what was set', ()=>{
    for (const version of [D3D9, D3D8])
    {
        assert.deepEqual(scripted(version, { guestCode: true, ringRoom: false },
            setAndRead(version)), [], version.dll);
    }
});

test('a reset during a recording leaves the getters in the guest reading the device', ()=>{
    for (const version of [D3D9, D3D8])
    {
        assert.deepEqual(scripted(version, { guestCode: true }, [
            step('BeginStateBlock', m=>m.call('device', 'BeginStateBlock', [])),
            step('every surface released, Reset', m=>{
                const answers = SURFACES.flatMap(surface=>(m.held.has(surface)
                    ? [m.release(surface)] : []));
                m.put(version.present(64, 64));
                return [...answers, m.call('device', 'Reset', [DATA])];
            }),
            ...setAndRead(version).filter(each=>each.label.startsWith('Set')),
            step('EndStateBlock', m=>m.call('device', 'EndStateBlock', [KEPT])),
            ...setAndRead(version).filter(each=>each.label.startsWith('Get')),
        ]), [], version.dll);
    }
});

test('a call the device refuses is not answered D3D_OK by the ring', ()=>{
    const refused = [
        step('SetRenderState(5, 1)', m=>m.call('device', 'SetRenderState', [5, 1])),
        step('SetRenderState(255, 1)', m=>m.call('device', 'SetRenderState', [255, 1])),
    ];
    assert.deepEqual(scripted(D3D9, { guestCode: true }, [...refused,
        step('SetSamplerState(0, 0, 1)', m=>m.call('device', 'SetSamplerState', [0, 0, 1])),
        step('SetSamplerState(0, 14, 1)', m=>m.call('device', 'SetSamplerState', [0, 14, 1])),
    ]), [], D3D9.dll);
    assert.deepEqual(scripted(D3D8, { guestCode: true }, [...refused,
        ...[0, 1, 4, 15].map(type=>step(`SetTransform(${type})`, m=>{
            m.put(SCALE);
            return m.call('device', 'SetTransform', [type, DATA]);
        })),
    ]), [], D3D8.dll);
});

test('a signalling NaN set reads back as it was set, in the guest and on the host', ()=>{
    const get = getters(D3D9);
    for (const version of [D3D9, D3D8])
    {
        const words = [...SCALE];
        words[5] = SIGNALLING;
        assert.deepEqual(scripted(version, { guestCode: true }, [
            step('SetTransform(VIEW, a signalling NaN in it)', m=>{
                m.put(words);
                return m.call('device', 'SetTransform', [D3DTS_VIEW, DATA]);
            }),
            get.transform(D3DTS_VIEW),
            step('SetViewport(0, 0, 32, 32, a signalling NaN, 1)', m=>{
                m.put([0, 0, 32, 32, SIGNALLING, floats([1])[0]]);
                return m.call('device', 'SetViewport', [DATA]);
            }),
            get.viewport(),
        ]), [], version.dll);
    }
});

test('the gate, the ring kept as traps and with no room for one', ()=>{
    /** @type {string[]} */
    const wrong = [];
    for (const version of [D3D9, D3D8])
    {
        for (const options of [{ guestCode: true }, { guestCode: true, guestTraps: ['ring'] },
            { guestCode: true, ringRoom: false }])
        {
            wrong.push(...gate(version, options, SEEDS.slice(0, 4), LENGTH, KNOWN).wrong
                .map(line=>`${version.dll} ${JSON.stringify(options)}: ${line}`));
        }
    }
    assert.deepEqual(wrong, []);
});
