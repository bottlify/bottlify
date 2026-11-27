/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The mirror of guest memory behind every played root (`createMirror`,
 * `playedOverMirror`): what it holds is bounded by what the played device
 * holds and what the last batches wrote, not by everything a program ever
 * sent. Each program below makes, writes, draws from and lets go of a page's
 * worth of something `ROUNDS` times, at an address it never uses again, as a
 * heap that moves on hands them out; its played root's diagnostics answer
 * says what the mirror held before and after.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceRooms, roomy } from '../../cache/testing.fixture.js';
import { playedAtOnce, playedDirect3D, recordedDirect3D } from './direct3d.js';
import { playedDirect3D7, recordedDirect3D7 } from './d3d7.js';
import { playedDirect3D10, recordedDirect3D10 } from './d3d10.js';
import { playedOpengl, recordedOpengl } from './opengl.js';
import { D3DFMT, D3DPOOL, D3DSWAPEFFECT, D3D_OK } from '../d3d9/constants.js';
import { createDirect3D9 } from '../d3d9/device.js';
import { createDirect3D8 } from '../d3d8/device.js';
import { DEVICE_IDS } from '../d3d7/constants.js';
import { D3DPT } from '../d3d8/constants.js';
import { createDirectDraw } from '../ddraw/objects.js';
import {
    DDPF_ALPHAPIXELS, DDPF_RGB, DDSCAPS_3DDEVICE, DDSCAPS_OFFSCREENPLAIN, DDSCAPS_TEXTURE,
    DDSCL_NORMAL, DDSD_CAPS, DDSD_HEIGHT, DDSD_PIXELFORMAT, DDSD_WIDTH,
} from '../ddraw/constants.js';
import { createDirect3D10 } from '../d3d10/root.js';
import {
    D3D10_BIND, D3D10_CPU_ACCESS, D3D10_DRIVER_TYPE, D3D10_MAP, D3D10_SDK_VERSION, D3D10_USAGE,
    S_OK,
} from '../d3d10/constants.js';
import { defaultSwapChainDesc } from '../d3d10/dxgi.js';
import { createOpengl } from '../opengl/exports.js';
import { GL } from '../opengl/constants.js';
import { FVF } from '../webgpu/internal/vertexformat.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/** A 64 KiB page of the mirror. */
const PAGE = 0x10000;
/** How many things a program makes and lets go of, each at a fresh address. */
const ROUNDS = 64;
/**
 * The most the mirror may hold past what it held before the rounds: the
 * pages the last two batches wrote, and those a thing made last reached
 * astride a page's edge.
 */
const SLACK = 4;

/** @param {any} descriptor */
const createSampler = descriptor=>({ kind: 'sampler', id: `sampler-${JSON.stringify(descriptor)}`,
    descriptor });

const gpuServices = ()=>{
    const gpu = createFakeDevice();
    return { gpu, backend: createBackend({ scratches: roomy.api.scratch,
        device: gpu.device, queue: gpu.queue,
        presentTo: ()=>{}, now: ()=>0 }) };
};

/**
 * Guest memory whose heap never hands an address out twice, from `base`.
 *
 * @param {number} [base]
 */
const freshMemory = (base = 0)=>{
    const ram = new Uint8Array(ROUNDS * PAGE * 3 + (4 << 20));
    let next = base + PAGE;
    return {
        ram, base,
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += (Math.max(bytes, 1) + 0xfff) & ~0xfff;
            return at;
        },
        free: ()=>{},
        readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            ram.slice(address - base, address - base + length),
        windowMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            ram.subarray(address - base, address - base + length),
        writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
            ram.set(bytes, address - base),
        /** @param {number} address @param {number} length @param {number} value */
        fill: (address, length, value)=>ram.fill(value, address - base, address - base + length),
    };
};

/**
 * A played root whose answers to diagnostics are kept: what its mirror held
 * at the last one (`withMirrored`).
 *
 * @template {{ play: (call: any) => any }} P
 * @param {P} played
 * @returns {P & { mirrored: () => { held: number, pages: number, reached: number } }}
 */
const answering = played=>{
    /** @type {any} */
    let last = null;
    const play = played.play;
    return Object.assign(played, {
        play: (/** @type {any} */ call)=>{
            const answer = play(call);
            if (call.m === 'diagnostics')
            {
                last = answer?.mirrored ?? null;
            }
            return answer;
        },
        mirrored: ()=>{
            assert.ok(last, 'the played root answered its diagnostics with its mirror');
            return last;
        },
    });
};

/**
 * What a program's rounds left in the mirror: it holds no more than before
 * them but for `SLACK`, though every round reached it.
 *
 * @param {{ pages: number, reached: number }} before
 * @param {{ pages: number, reached: number }} after
 */
const bounded = (before, after)=>{
    assert.ok(after.reached >= before.reached + ROUNDS * PAGE,
        `every round reached the mirror: ${after.reached - before.reached} bytes`);
    assert.ok(after.pages <= before.pages + SLACK,
        `the mirror holds ${after.pages} pages, ${before.pages} before ${ROUNDS} rounds came`
        + ' and went');
};

/**
 * A Direct3D 8 or 9 program: vertex buffers of a page made, written, drawn
 * from, and let go of.
 *
 * @param {8 | 9} version
 */
const direct3DRounds = version=>{
    const factory = version === 9 ? createDirect3D9 : createDirect3D8;
    const memory = freshMemory(0x40000000);
    const { backend } = gpuServices();
    const played = answering(playedDirect3D(factory, { ...deviceRooms(), backend, createSampler,
        readMemory: true,
        writeMemory: memory.writeMemory }));
    const d3d = recordedDirect3D(factory, { ...deviceRooms(), readMemory: memory.readMemory,
        windowMemory: memory.windowMemory, writeMemory: memory.writeMemory,
        allocate: memory.allocate, free: memory.free }, playedAtOnce(played));
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
        backBufferWidth: 32, backBufferHeight: 32, backBufferFormat: D3DFMT.X8R8G8B8,
        enableAutoDepthStencil: true, autoDepthStencilFormat: D3DFMT.D24S8 }, out), D3D_OK);
    const device = out.device;
    const fvf = FVF.XYZ | FVF.DIFFUSE;
    const setFvf = version === 9 ? ()=>device.SetFVF(fvf) : ()=>device.SetVertexShader(fvf);
    assert.equal(setFvf(), D3D_OK);
    device.diagnostics();
    const before = played.mirrored();
    for (let round = 0; round < ROUNDS; round++)
    {
        /** @type {{ buffer?: any }} */
        const made = {};
        assert.equal(device.CreateVertexBuffer(PAGE, 0, fvf, D3DPOOL.MANAGED, made), D3D_OK);
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(made.buffer.Lock(0, 0, locked, 0), D3D_OK);
        memory.fill(/** @type {number} */ (locked.pBits), PAGE, round + 1);
        assert.equal(made.buffer.Unlock(), D3D_OK);
        assert.equal(version === 9 ? device.SetStreamSource(0, made.buffer, 0, 16)
            : device.SetStreamSource(0, made.buffer, 16), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 3 * round, 1), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        assert.equal(version === 9 ? device.SetStreamSource(0, null, 0, 0)
            : device.SetStreamSource(0, null, 0), D3D_OK);
        assert.equal(made.buffer.release(), 0);
    }
    device.diagnostics();
    return { before, after: played.mirrored() };
};

test('Direct3D 9: the mirror lets go of the pages of buffers the device let go of', ()=>{
    const { before, after } = direct3DRounds(9);
    bounded(before, after);
});

test('Direct3D 8: the mirror lets go of the pages of buffers the device let go of', ()=>{
    const { before, after } = direct3DRounds(8);
    bounded(before, after);
});

const ARGB32 = Object.freeze({
    size: 0x20, flags: DDPF_RGB | DDPF_ALPHAPIXELS, fourCC: 0, bitCount: 32,
    redMask: 0xff0000, greenMask: 0xff00, blueMask: 0xff, alphaMask: 0xff000000,
});

/** A pre-transformed, textured strip of four corners: x, y, z, rhw, colour, u, v. */
const texturedStrip = ()=>{
    const view = new DataView(new ArrayBuffer(28 * 4));
    [[0, 0], [8, 0], [0, 8], [8, 8]].forEach(([x, y], index)=>{
        view.setFloat32(index * 28, x, true);
        view.setFloat32(index * 28 + 4, y, true);
        view.setFloat32(index * 28 + 12, 1, true);
        view.setUint32(index * 28 + 16, 0xffffffff, true);
        view.setFloat32(index * 28 + 20, x / 8, true);
        view.setFloat32(index * 28 + 24, y / 8, true);
    });
    return new Uint8Array(view.buffer);
};

test('Direct3D 7: the mirror lets go of the pixels of surfaces DirectDraw gave back, and of'
    + ' the vertex buffers the device let go of', ()=>{
    const memory = freshMemory();
    const ddraw = createDirectDraw({ version: 7, screenWidth: 16, screenHeight: 16,
        allocate: memory.allocate });
    ddraw.setCooperativeLevel(0x00010044, DDSCL_NORMAL);
    const { backend } = gpuServices();
    const services = { backend, createSampler, readMemory: memory.readMemory,
        writeMemory: memory.writeMemory, presenter: { claim: ()=>{}, release: ()=>{} } };
    const played = answering(playedDirect3D7({ ...deviceRooms(), ...services }));
    const d3d = recordedDirect3D7(ddraw, { ...deviceRooms(), ...services }, playedAtOnce(/** @type {any} */ (played)));
    /** @param {any} request */
    const surface = request=>{
        const result = ddraw.createSurface(request);
        assert.equal(result.hr, D3D_OK);
        return /** @type {any} */ (result.surface);
    };
    const target = surface({ flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT,
        caps: DDSCAPS_3DDEVICE | DDSCAPS_OFFSCREENPLAIN, width: 8, height: 8 });
    const created = d3d.createDevice(DEVICE_IDS.TNLHAL, target);
    assert.equal(created.hr, D3D_OK);
    const device = created.device;
    const fvf = FVF.XYZRHW | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT);
    device.diagnostics();
    const before = played.mirrored();
    for (let round = 0; round < ROUNDS; round++)
    {
        // A texture of a page, sent ahead of the draw that samples it.
        const texture = surface({ flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT,
            caps: DDSCAPS_TEXTURE, width: 128, height: 128, pixelFormat: ARGB32 });
        memory.fill(texture.buffer, texture.pitch * texture.height, round + 1);
        assert.equal(texture.lock(null, 0).hr, D3D_OK);
        assert.equal(texture.unlock(null), D3D_OK);
        // A vertex buffer of a page, whose bytes go with its unlock.
        const vb = d3d.createVertexBuffer({ caps: 0, fvf, numVertices: PAGE / 28 });
        assert.equal(vb.hr, D3D_OK);
        /** @type {{ data?: number }} */
        const lock = {};
        assert.equal(vb.buffer.Lock(0, lock), D3D_OK);
        memory.fill(/** @type {number} */ (lock.data), PAGE / 28 * 28, round + 1);
        assert.equal(vb.buffer.Unlock(), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetTexture(0, texture), D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLESTRIP, fvf, texturedStrip(), 4), D3D_OK);
        assert.equal(device.DrawPrimitiveVB(D3DPT.TRIANGLESTRIP, vb.buffer, 0, 4), D3D_OK);
        assert.equal(device.SetTexture(0, null), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        assert.equal(vb.buffer.release(), 0);
        assert.equal(texture.release(), 0);
    }
    device.diagnostics();
    bounded(before, played.mirrored());
});

test('Direct3D 10: the mirror lets go of the storage of buffers the device let go of', async()=>{
    const memory = freshMemory();
    const storage = { allocate: memory.allocate, free: memory.free,
        readMemory: memory.readMemory, writeMemory: memory.writeMemory };
    const { gpu, backend } = gpuServices();
    const played = answering(playedDirect3D10(createDirect3D10, { ...deviceRooms(), backend,
        createSampler,
        createTexture: gpu.device.createTexture, writeMemory: memory.writeMemory }));
    const root = recordedDirect3D10(createDirect3D10, { ...deviceRooms(), guest: storage },
        playedAtOnce(/** @type {any} */ (played)));
    const desc = defaultSwapChainDesc();
    desc.bufferDesc.width = 8;
    desc.bufferDesc.height = 8;
    desc.outputWindow = 0x1234;
    /** @type {{ device?: any }} */
    const deviceOut = {};
    assert.equal(root.CreateDeviceAndSwapChain(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0,
        D3D10_SDK_VERSION, desc, {}, deviceOut), S_OK);
    const device = deviceOut.device;
    device.diagnostics();
    const before = played.mirrored();
    for (let round = 0; round < ROUNDS; round++)
    {
        /** @type {{ resource?: any }} */
        const made = {};
        assert.equal(device.CreateBuffer({ ByteWidth: PAGE, Usage: D3D10_USAGE.DYNAMIC,
            BindFlags: D3D10_BIND.VERTEX_BUFFER, CPUAccessFlags: D3D10_CPU_ACCESS.WRITE,
            MiscFlags: 0 }, null, made), S_OK);
        /** @type {{ pData?: number }} */
        const out = {};
        assert.equal(await made.resource.Map(0, D3D10_MAP.WRITE_DISCARD, 0, out), S_OK);
        memory.fill(/** @type {number} */ (out.pData), PAGE, round + 1);
        made.resource.Unmap(0);
        device.IASetVertexBuffers(0, [made.resource], [16], [0]);
        device.IASetVertexBuffers(0, [null], [0], [0]);
        assert.equal(made.resource.release(), 0);
    }
    device.diagnostics();
    bounded(before, played.mirrored());
});

test('OpenGL: the mirror lets go of the pixels a call read and of the buffers mapped and'
    + ' unmapped', ()=>{
    const memory = freshMemory();
    const { backend } = gpuServices();
    /** @type {ReturnType<typeof answering<any>> | null} */
    let played = null;
    const opengl = createOpengl({
        readMemory: memory.windowMemory,
        windowMemory: memory.windowMemory,
        writeMemory: memory.writeMemory,
        scratch: { allocate: memory.allocate, free: memory.free },
        screen: ()=>({ width: 16, height: 16 }),
        present: ()=>{},
        presenter: ()=>({ claim: ()=>{} }),
        backend: ()=>backend,
        createSampler,
        remote: (/** @type {any} */ factory, /** @type {any} */ services)=>{
            played = answering(playedOpengl(factory, services));
            return recordedOpengl(factory, services, playedAtOnce(played));
        },
    });
    const table = /** @type {Record<string, { handler: (args: number[]) => any }>} */ (
        opengl.table);
    /** @param {string} name @param {number[]} args */
    const gl = (name, ...args)=>table[name].handler(args);
    assert.equal(gl('wglSetPixelFormat', 0x900d, 1, 0), 1);
    const context = gl('wglCreateContext', 0x900d);
    assert.equal(gl('wglMakeCurrent', 0x900d, context), 1);
    const names = memory.allocate(16);
    gl('glGenBuffersARB', 1, names);
    const buffer = memory.readMemory(names, 4)[0] | memory.readMemory(names + 1, 1)[0] << 8;
    gl('glBindBufferARB', GL.ARRAY_BUFFER, buffer);
    gl('glBufferDataARB', GL.ARRAY_BUFFER, PAGE, 0, GL.DYNAMIC_DRAW);
    opengl.diagnostics();
    const asked = /** @type {any} */ (played);
    const before = asked.mirrored();
    for (let round = 0; round < ROUNDS; round++)
    {
        // A texture's pixels, read out of the program's memory by the call.
        const pixels = memory.allocate(PAGE);
        memory.fill(pixels, PAGE, round + 1);
        gl('glGenTextures', 1, names);
        const texture = memory.readMemory(names, 4)[0] | memory.readMemory(names + 1, 1)[0] << 8;
        gl('glBindTexture', GL.TEXTURE_2D, texture);
        gl('glTexImage2D', GL.TEXTURE_2D, 0, GL.RGBA, 128, 128, 0, GL.RGBA, GL.UNSIGNED_BYTE,
            pixels);
        gl('glDeleteTextures', 1, names);
        // A buffer written through its mapping, at a block given back at its unmap.
        const mapped = gl('glMapBufferARB', GL.ARRAY_BUFFER, GL.WRITE_ONLY);
        assert.notEqual(mapped, 0);
        memory.fill(mapped, PAGE, round + 1);
        assert.equal(gl('glUnmapBufferARB', GL.ARRAY_BUFFER), 1);
    }
    opengl.diagnostics();
    bounded(before, asked.mirrored());
    assert.equal(gl('wglMakeCurrent', 0, 0), 1);
});
