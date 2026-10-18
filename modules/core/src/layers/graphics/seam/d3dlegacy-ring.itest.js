/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of Direct3D 3's setters in the guest: seeded random programs of
 * render states, stage states, transforms, textures and draws, made on one
 * legacy device by its host methods alone and on another through the
 * routines the seam places in its table (`LEGACY_DEVICE_COMMANDS`), run by
 * the real processor into the ring of the Direct3D 7 device underneath and
 * made there as the seam makes them, a host call making the ring first.
 * Every answer the program is given, every call the Direct3D 7 device is
 * made to take -- its arguments and its answer, in order -- and every state
 * read back must agree.
 *
 * Run with: node --test src/layers/graphics/seam/d3dlegacy-ring.itest.js (in modules/core)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import { runToHalt } from '../../cpu/internal/halt.fixture.js';
import * as cork from '../../../../../cork/src/index.js';
import { SHADOW, commandCode } from './shadow.js';
import { LEGACY_DEVICE_COMMANDS, tellTaken, withoutStates } from './d3d7.js';
import { D3D7_COMMANDS } from '../d3d7/commands.js';
import { createDirect3D7 } from '../d3d7/device.js';
import { createLegacyDirect3D, createTextureHandles } from '../d3d7/legacy.js';
import { DEVICE_IDS } from '../d3d7/constants.js';
import { createDirectDraw } from '../ddraw/objects.js';
import {
    DDSCAPS_3DDEVICE, DDSCAPS_OFFSCREENPLAIN, DDSCAPS_TEXTURE, DDSCL_NORMAL, DDSD_CAPS,
    DDSD_HEIGHT, DDSD_WIDTH,
} from '../ddraw/constants.js';

const PROGRAM = 0x8000;
const ROUTINE = 0x9000;
const TRAP = 0x8e00;
const BLOCK = 0xa000;
const RING = 0xd000;
const RING_BYTES = 0x8000;
const DATA = 0x18000;
const STACK = 0x300000;
/** The device's interface: its block one word on. */
const DEVICE = 0x17000;
/** The textures' interfaces, one word apart for the records that name them. */
const TEXTURES = 0x17800;

const D3D_OK = 0;
const D3DPT_TRIANGLELIST = 4;
/** XYZRHW | DIFFUSE: 20 bytes a vertex. */
const FVF_TL = 0x044;

/** The render states the legacy device answers for itself (`legacy.js` ownStates). */
const OWN_STATES = [1, 3, 5, 6, 17, 18, 21, 43, 44, 45, 46, 49, 137];
/** Render states of the device underneath, and a few no device has. */
const OTHER_STATES = [2, 4, 7, 8, 9, 14, 15, 16, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 34,
    128, 129, 136, 139, 140, 143, 147, 255, 256, 300];

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** A seeded generator, so a failing round names a case that comes again. @param {number} seed */
function seeded(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state * 1103515245 + 12345) >>> 0;
        return state / 0x100000000;
    };
}

/** The processor, with a routine's device block and ring at fixed places. */
function machine(){
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
     * A fresh block and an empty ring, the render states the device holds as
     * valid in it.
     *
     * @param {Uint8Array} valid
     */
    const start = valid=>{
        host.writePhysical(BLOCK, new Uint8Array(SHADOW.SIZE));
        host.writePhysical(BLOCK + SHADOW.COMMANDS,
            new Uint8Array([...u32(RING), ...u32(RING_BYTES)]));
        host.writePhysical(BLOCK + SHADOW.RENDER_STATE_VALID, valid);
    };
    /**
     * Runs `routine` on the device with `args`: true for a call it wrote into
     * the ring and answered D3D_OK, false for one it left to the trap.
     *
     * @param {Uint8Array} routine @param {number[]} args
     */
    const call = (routine, args)=>{
        host.writePhysical(ROUTINE, routine);
        const before = read(BLOCK + SHADOW.COMMAND_HEAD);
        /** @type {number[]} */
        const code = [];
        for (const value of [...args].reverse())
        {
            code.push(0x68, ...u32(value));
        }
        code.push(0x68, ...u32(DEVICE));
        code.push(0xe8, ...u32((ROUTINE - (PROGRAM + code.length + 5)) | 0), 0xf4);
        host.writePhysical(PROGRAM, new Uint8Array(code));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        runToHalt(host, 20000);
        if (host.readReg32('eip') === TRAP + 1)
        {
            assert.equal(read(BLOCK + SHADOW.COMMAND_HEAD), before,
                'a call left to the trap leaves the ring as it was');
            return false;
        }
        assert.equal(host.readReg32('eip'), PROGRAM + code.length, 'the routine returned');
        assert.equal(host.readReg32('eax'), D3D_OK, 'and answered D3D_OK');
        return true;
    };
    /** What the routines wrote since the host last made the ring, and the ring emptied. */
    const take = ()=>{
        const records = host.readPhysical(RING, read(BLOCK + SHADOW.COMMAND_HEAD)).slice();
        host.writePhysical(BLOCK + SHADOW.COMMAND_HEAD, new Uint8Array(4));
        return records;
    };
    return { host, start, call, take };
}

/**
 * A legacy device of the third generation over a Direct3D 7 one whose every
 * call is written down with its answer, and textures to bind.
 */
function side(){
    const root = createDirectDraw({ version: 7, screenWidth: 64, screenHeight: 64 });
    root.setCooperativeLevel(0x00010044, DDSCL_NORMAL);
    const surfaceOf = (/** @type {number} */ caps, /** @type {number} */ size)=>{
        const made = root.createSurface({ flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT, caps,
            width: size, height: size });
        assert.equal(made.hr, D3D_OK);
        return made.surface;
    };
    const target = surfaceOf(DDSCAPS_3DDEVICE | DDSCAPS_OFFSCREENPLAIN, 64);
    const textures = [0, 1, 2].map(()=>surfaceOf(DDSCAPS_TEXTURE, 8));
    /** @type {any[]} */
    const log = [];
    /** @param {any} value */
    const named = value=>{
        const index = textures.indexOf(value);
        if (index >= 0)
        {
            return `texture${index}`;
        }
        return value && typeof value === 'object' && typeof value.length === 'number'
            ? Array.from(value) : value;
    };
    const d3d7 = createDirect3D7(root);
    const watched = {
        ...d3d7,
        /** @param {string} id @param {any} on */
        createDevice(id, on){
            const made = d3d7.createDevice(id, on);
            if (made.device)
            {
                const inner = made.device;
                made.device = new Proxy(inner, {
                    get(object, key){
                        const value = object[key];
                        if (typeof value !== 'function' || typeof key !== 'string'
                            || !/^[A-Z]/.test(key) || key.startsWith('Get'))
                        {
                            return value;
                        }
                        return (/** @type {any[]} */ ...args)=>{
                            const hr = value.apply(object, args);
                            log.push([key, ...args.map(named), hr]);
                            return hr;
                        };
                    },
                });
            }
            return made;
        },
    };
    const handles = createTextureHandles();
    const legacy = createLegacyDirect3D(watched, handles);
    const made = legacy.createDevice(DEVICE_IDS.HAL, target, 3);
    assert.equal(made.hr, D3D_OK);
    const device = made.device;
    // Every texture has a handle, for TEXTUREHANDLE to name.
    const textureHandles = textures.map(texture=>handles.handleOf(texture));
    assert.equal(device.BeginScene(), D3D_OK);
    log.length = 0;
    return { device, textures, textureHandles, log };
}

/**
 * The states read back: every render state as the legacy device answers it,
 * every stage state, every transform and every stage's texture.
 *
 * @param {ReturnType<typeof side>} one
 */
function stateOf(one){
    const { device, textures } = one;
    /** @type {any[]} */
    const read = [];
    for (let state = 0; state < 300; state++)
    {
        /** @type {{ value?: number }} */
        const out = {};
        read.push(['rs', state, device.getRenderState(state, out), out.value]);
    }
    for (let stage = 0; stage < 8; stage++)
    {
        for (let type = 1; type < 28; type++)
        {
            /** @type {{ value?: number }} */
            const out = {};
            read.push(['tss', stage, type, device.inner.GetTextureStageState(stage, type, out),
                out.value]);
        }
        /** @type {{ surface?: any }} */
        const bound = {};
        device.inner.GetTexture(stage, bound);
        read.push(['texture', stage, textures.indexOf(bound.surface)]);
        bound.surface?.release();
    }
    for (const type of [1, 2, 3, 4, 5, 6, 16, 23])
    {
        /** @type {{ matrix?: Float32Array }} */
        const out = {};
        read.push(['transform', type, device.getTransform(type, out),
            out.matrix ? Array.from(out.matrix) : null]);
    }
    return read;
}

test('Direct3D 3\'s setters in the guest make on the device what its host methods make', ()=>{
    const random = seeded(31);
    const pick = (/** @type {any[]} */ list)=>list[Math.floor(random() * list.length)];
    const run = machine();
    /** @type {Record<string, Uint8Array>} */
    const routines = Object.fromEntries(Object.entries(LEGACY_DEVICE_COMMANDS)
        .map(([name, shape])=>[name, commandCode(ROUTINE, TRAP, shape)]));
    const triangle = new Uint8Array(3 * 20);
    const recorded = { ring: 0, host: 0 };
    for (let round = 0; round < 120; round++)
    {
        const host = side();
        const guest = side();
        // The block's valid render states, as the seam makes them: the
        // Direct3D 7 device's, less those the legacy device answers for.
        const answering = withoutStates(guest.device.inner, state=>guest.device.answersFor(state));
        const valid = new Uint8Array(SHADOW.RENDER_STATE_COUNT / 8);
        for (let state = 0; state < SHADOW.RENDER_STATE_COUNT; state++)
        {
            if (answering.GetRenderState(state, {}) === D3D_OK)
            {
                valid[state >>> 3] |= 1 << (state & 7);
            }
        }
        run.start(valid);
        /** The ring made on the guest's device as the seam's take makes it. */
        const settle = ()=>{
            const records = run.take();
            if (records.length === 0)
            {
                return;
            }
            const objects = D3D7_COMMANDS.commandObjects(records, pointer=>(pointer === 0 ? null
                : guest.textures[(pointer - TEXTURES) / 4] ?? null));
            tellTaken(records, (name, args)=>guest.device.ringTaken(name, args));
            D3D7_COMMANDS.runCommands(guest.device.inner, records, objects, ()=>{});
        };
        for (let step = 0; step < 40; step++)
        {
            const kind = pick(['SetRenderState', 'SetRenderState', 'SetTextureStageState',
                'SetTextureStageState', 'SetTransform', 'SetTexture', 'draw']);
            if (kind === 'draw')
            {
                settle();
                const drawn = guest.device.drawPrimitive(D3DPT_TRIANGLELIST, FVF_TL, triangle,
                    3, 0);
                assert.equal(drawn, host.device.drawPrimitive(D3DPT_TRIANGLELIST, FVF_TL,
                    triangle, 3, 0), `round ${round} step ${step}: the draw's answer`);
                continue;
            }
            /** @type {number[]} */
            let args;
            /** @type {(device: any, one: ReturnType<typeof side>) => number} */
            let made;
            if (kind === 'SetRenderState')
            {
                const state = random() < 0.4 ? pick(OWN_STATES) : pick(OTHER_STATES);
                const value = state === 1 ? pick([0, ...host.textureHandles])
                    : state === 21 ? 1 + Math.floor(random() * 8)
                        : pick([0, 1, 2, 3, 4, 8, 0xff, 0x12345678]);
                args = [state, value];
                made = device=>device.setRenderState(state, value);
            }
            else if (kind === 'SetTextureStageState')
            {
                const stage = random() < 0.6 ? 0 : Math.floor(random() * 9);
                const type = 1 + Math.floor(random() * 28);
                const value = pick([0, 1, 2, 3, 4, 5, 7, 13, 26]);
                args = [stage, type, value];
                made = device=>device.setTextureStageState(stage, type, value);
            }
            else if (kind === 'SetTransform')
            {
                const type = pick([0, 1, 2, 3, 3, 4, 6, 7, 16, 23, 256]);
                const matrix = Array.from({ length: 16 }, ()=>Math.round(random() * 40 - 20) / 4);
                run.host.writePhysical(DATA, new Uint8Array(new Float32Array(matrix).buffer));
                args = [type, DATA];
                made = device=>device.setTransform(type, Float32Array.from(matrix));
            }
            else
            {
                const stage = random() < 0.6 ? 0 : Math.floor(random() * 9);
                const which = Math.floor(random() * 4);
                args = [stage, which === 3 ? 0 : TEXTURES + which * 4];
                made = (device, one)=>device.setTexture(stage, which === 3 ? null
                    : one.textures[which]);
            }
            const answer = made(host.device, host);
            const what = `round ${round} step ${step}: ${kind}(${args.join(', ')})`;
            if (run.call(routines[kind], args))
            {
                recorded.ring++;
                assert.equal(answer, D3D_OK, `${what} answered D3D_OK in the guest, the host`
                    + ` refuses it`);
            }
            else
            {
                recorded.host++;
                settle();
                assert.equal(made(guest.device, guest), answer, what);
            }
        }
        settle();
        assert.deepEqual(guest.log, host.log, `round ${round}: the calls the device was made`);
        assert.deepEqual(stateOf(guest), stateOf(host), `round ${round}: the states read back`);
    }
    // Both ways were taken, and often.
    assert.ok(recorded.ring > 1000 && recorded.host > 300, JSON.stringify(recorded));
});
