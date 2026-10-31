/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A gate for Direct3D 10 drawn elsewhere: a program's calls on a recorded
 * root, played on a twin with a GPU behind it (`remote/d3d10.js`), give the
 * GPU what the same calls give it on a root that draws itself.
 *
 * Each program is drawn from a seed out of what a frame is made of: a
 * dynamic vertex buffer mapped with DISCARD and NO_OVERWRITE and written
 * through the address the map hands out, a constant buffer mapped each draw,
 * an update of a default buffer, a buffer read back through a staging copy, a
 * clear, a viewport, the bindings switched between, an occlusion query, and
 * presents. It runs twice, each on a guest memory of its own: once on a root
 * that draws, once recorded and played at once on a second root of the same
 * build. What is compared is every call's answer, the bytes the program read
 * back, and what every draw the GPU is given reads (`gpuReads`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDirect3D10 } from '../d3d10/root.js';
import {
    D3D10_BIND, D3D10_CPU_ACCESS, D3D10_DRIVER_TYPE, D3D10_MAP, D3D10_PRIMITIVE_TOPOLOGY,
    D3D10_QUERY, D3D10_SDK_VERSION, D3D10_USAGE, DXGI_FORMAT, IID, S_OK,
} from '../d3d10/constants.js';
import { defaultSwapChainDesc } from '../d3d10/dxgi.js';
import { SHADER_KIND, SYSTEM_VALUE } from '../d3d10/dxbc.js';
import {
    assemble, cb, colouredPixelShader, colouredVertexShader, dclConstantBuffer, dclOutput, mov, o,
    ret,
} from '../d3d10/shader-fixtures.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { gpuReads, idle } from '../seam/frames-contract.itest.js';
import { playedAtOnce } from './direct3d.js';
import { playedDirect3D10, recordedDirect3D10 } from './d3d10.js';

/** @param {number} seed */
const random = seed=>{
    let drawn = 0;
    const next = ()=>createHash('sha256').update(`${seed}:${drawn++}`).digest()
        .readUInt32LE(0) / 4294967296;
    return {
        /** @param {number} n */
        below: n=>Math.floor(next() * n),
        /** @template T @param {T[]} list @returns {T} */
        pick: list=>list[Math.floor(next() * list.length)],
        float: ()=>next() * 2 - 1,
    };
};

/**
 * Guest memory as the engine gives it: a bump heap, and a write watch at page
 * grain with a view of its own for each watch, as the engine's write clock
 * gives one to each buffer.
 */
function guestMemory(){
    const memory = new Uint8Array(1 << 20);
    let next = 0x10000;
    /** The writes each page has had. @type {Uint32Array} */
    const versions = new Uint32Array(memory.length >>> 12);
    /** @param {number} address @param {number} length */
    const mark = (address, length)=>{
        for (let page = address >>> 12; page <= (address + length - 1) >>> 12; page++)
        {
            versions[page]++;
        }
    };
    /** @param {number} address @param {Uint8Array} bytes */
    const store = (address, bytes)=>{
        memory.set(bytes, address);
        mark(address, bytes.length);
    };
    return {
        memory,
        store,
        /** @type {import('../d3d10/render.js').GuestStorage} */
        storage: {
            allocate: bytes=>{
                const at = next;
                next += (bytes + 0xfff) & ~0xfff;
                return at;
            },
            free: ()=>{},
            readMemory: (address, length)=>memory.slice(address, address + length),
            writeMemory: store,
            watchWrites: (base, length)=>{
                const seen = versions.slice(base >>> 12, ((base + length - 1) >>> 12) + 1);
                return {
                    take: (address, size)=>{
                        /** @type {number[]} */
                        const pages = [];
                        for (let page = address >>> 12; page <= (address + size - 1) >>> 12;
                            page++)
                        {
                            const at = page - (base >>> 12);
                            if (at >= 0 && at < seen.length && seen[at] !== versions[page])
                            {
                                seen[at] = versions[page];
                                pages.push(page);
                            }
                        }
                        return pages;
                    },
                };
            },
        },
    };
}

/** A pixel shader whose colour is the first register of cb0. */
const constantPixelShader = ()=>assemble({
    kind: SHADER_KIND.PIXEL,
    outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
    instructions: [dclConstantBuffer(0, 1), dclOutput(o(0)), mov(o(0), cb(0, 0)), ret()],
});

const STRIDE = 32;
const VERTICES = 128;
const BUFFER_BYTES = VERTICES * STRIDE;

/** @param {number[]} floats */
const floatBytes = floats=>new Uint8Array(Float32Array.from(floats).buffer);

/**
 * One program run on one root, its answers and what the GPU read.
 *
 * @param {number} seed @param {number} steps @param {boolean} recorded
 */
async function run(seed, steps, recorded){
    const gpu = createFakeDevice();
    const reads = gpuReads(gpu);
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const guest = guestMemory();
    /** @type {string[]} */
    const divergences = [];
    const drawing = {
        backend,
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }),
        createTexture: gpu.device.createTexture,
        divergence: (/** @type {string} */ api, /** @type {string} */ detail)=>
            divergences.push(`${api}: ${detail}`),
    };
    const root = recorded
        ? recordedDirect3D10(createDirect3D10, { guest: guest.storage },
            playedAtOnce(playedDirect3D10(createDirect3D10, { ...drawing,
                writeMemory: guest.store })))
        : createDirect3D10({ ...drawing, guest: guest.storage });
    const pick = random(seed);
    /** @type {any[]} */
    const answers = [];
    /** @param {string} what @param {any} answer */
    const answered = (what, answer)=>{
        answers.push(`${what} ${JSON.stringify(answer)}`);
        return answer;
    };

    const desc = defaultSwapChainDesc();
    desc.bufferDesc.width = 8;
    desc.bufferDesc.height = 8;
    desc.outputWindow = 0x1234;
    /** @type {{ device?: any }} */
    const deviceOut = {};
    /** @type {{ swapChain?: any }} */
    const chainOut = {};
    // On an odd seed the device is made on an adapter the program enumerated.
    /** @type {{ object?: any }} */
    const factory = {};
    /** @type {{ adapter?: any }} */
    const adapter = {};
    if (seed % 2 === 1)
    {
        assert.equal(root.CreateDXGIFactory(IID.IDXGIFactory, factory), S_OK);
        assert.equal(factory.object.EnumAdapters(0, adapter), S_OK);
    }
    assert.equal(root.CreateDeviceAndSwapChain(adapter.adapter ?? null,
        D3D10_DRIVER_TYPE.HARDWARE, null, 0, D3D10_SDK_VERSION, desc, chainOut, deviceOut), S_OK);
    const device = deviceOut.device;
    const swapChain = chainOut.swapChain;
    /** @type {{ buffer?: any }} */
    const held = {};
    assert.equal(swapChain.GetBuffer(0, '{9B7E4C04-342C-4106-A19F-4F2704F689F0}', held), S_OK);
    /** @type {{ view?: any }} */
    const view = {};
    assert.equal(device.CreateRenderTargetView(held.buffer, null, view), S_OK);

    /** @param {any} bufferDesc @param {any} [data] */
    const buffer = (bufferDesc, data = null)=>{
        /** @type {{ resource?: any }} */
        const made = {};
        assert.equal(device.CreateBuffer({ MiscFlags: 0, ...bufferDesc }, data, made), S_OK);
        return made.resource;
    };
    const dynamic = buffer({ ByteWidth: BUFFER_BYTES, Usage: D3D10_USAGE.DYNAMIC,
        BindFlags: D3D10_BIND.VERTEX_BUFFER, CPUAccessFlags: D3D10_CPU_ACCESS.WRITE });
    const initial = floatBytes(Array.from({ length: BUFFER_BYTES / 4 }, ()=>pick.float()));
    const fixed = buffer({ ByteWidth: BUFFER_BYTES, Usage: D3D10_USAGE.DEFAULT,
        BindFlags: D3D10_BIND.VERTEX_BUFFER, CPUAccessFlags: 0 },
    { pSysMem: initial, SysMemPitch: 0, SysMemSlicePitch: 0 });
    const constants = buffer({ ByteWidth: 16, Usage: D3D10_USAGE.DYNAMIC,
        BindFlags: D3D10_BIND.CONSTANT_BUFFER, CPUAccessFlags: D3D10_CPU_ACCESS.WRITE });
    const staging = buffer({ ByteWidth: BUFFER_BYTES, Usage: D3D10_USAGE.STAGING, BindFlags: 0,
        CPUAccessFlags: D3D10_CPU_ACCESS.READ });
    /** @param {(bytecode: Uint8Array, out: any) => number} make @param {Uint8Array} code */
    const shader = (make, code)=>{
        /** @type {{ shader?: any }} */
        const out = {};
        assert.equal(make.call(device, code, out), S_OK);
        return out.shader;
    };
    const vs = shader(device.CreateVertexShader, colouredVertexShader());
    const pixelShaders = [shader(device.CreatePixelShader, colouredPixelShader()),
        shader(device.CreatePixelShader, constantPixelShader())];
    /** @type {{ layout?: any }} */
    const layout = {};
    assert.equal(device.CreateInputLayout([
        { SemanticName: 'POSITION', SemanticIndex: 0, Format: DXGI_FORMAT.R32G32B32A32_FLOAT,
            InputSlot: 0, AlignedByteOffset: 0, InputSlotClass: 0, InstanceDataStepRate: 0 },
        { SemanticName: 'COLOR', SemanticIndex: 0, Format: DXGI_FORMAT.R32G32B32A32_FLOAT,
            InputSlot: 0, AlignedByteOffset: 16, InputSlotClass: 0, InstanceDataStepRate: 0 },
    ], colouredVertexShader(), layout), S_OK);
    /** @type {{ query?: any }} */
    const query = {};
    assert.equal(device.CreateQuery({ Query: D3D10_QUERY.OCCLUSION, MiscFlags: 0 }, query), S_OK);

    device.IASetInputLayout(layout.layout);
    device.VSSetShader(vs);
    device.PSSetShader(pixelShaders[0]);
    device.PSSetConstantBuffers(0, [constants]);
    device.OMSetRenderTargets([view.view], null);
    device.RSSetViewports([{ TopLeftX: 0, TopLeftY: 0, Width: 8, Height: 8, MinDepth: 0,
        MaxDepth: 1 }]);
    device.IASetPrimitiveTopology(D3D10_PRIMITIVE_TOPOLOGY.TRIANGLELIST);
    device.IASetVertexBuffers(0, [dynamic], [STRIDE], [0]);

    /** @param {any} resource @param {number} type @returns {Promise<{ pData?: number }>} */
    const map = async(resource, type)=>{
        /** @type {{ pData?: number, rowPitch?: number, bytes?: number }} */
        const out = {};
        const hr = await resource.Map(0, type, 0, out);
        answered('Map', [hr, out.pData, out.rowPitch, out.bytes]);
        assert.equal(hr, S_OK);
        return out;
    };
    const draw = ()=>{
        const count = 3 * (1 + pick.below(4));
        device.Draw(count, pick.below(VERTICES - count));
    };
    const actions = {
        mapDynamic: async()=>{
            const out = await map(dynamic, pick.pick([D3D10_MAP.WRITE_DISCARD,
                D3D10_MAP.WRITE_NO_OVERWRITE]));
            const first = pick.below(VERTICES - 8);
            const count = 1 + pick.below(8);
            guest.store(/** @type {number} */ (out.pData) + first * STRIDE,
                floatBytes(Array.from({ length: count * STRIDE / 4 }, ()=>pick.float())));
            dynamic.Unmap(0);
        },
        mapConstants: async()=>{
            const out = await map(constants, D3D10_MAP.WRITE_DISCARD);
            guest.store(/** @type {number} */ (out.pData),
                floatBytes([pick.float(), pick.float(), pick.float(), 1]));
            constants.Unmap(0);
        },
        update: async()=>{
            const first = pick.below(VERTICES - 4);
            const count = 1 + pick.below(4);
            device.UpdateSubresource(fixed, 0, { left: first * STRIDE,
                right: (first + count) * STRIDE, top: 0, bottom: 1, front: 0, back: 1 },
            floatBytes(Array.from({ length: count * STRIDE / 4 }, ()=>pick.float())), 0, 0);
        },
        bind: async()=>{
            device.IASetVertexBuffers(0, [pick.pick([dynamic, fixed])], [STRIDE],
                [STRIDE * pick.below(8)]);
            device.PSSetShader(pick.pick(pixelShaders));
            device.IASetPrimitiveTopology(pick.pick([D3D10_PRIMITIVE_TOPOLOGY.TRIANGLELIST,
                D3D10_PRIMITIVE_TOPOLOGY.TRIANGLESTRIP]));
        },
        viewport: async()=>{
            const x = pick.below(4);
            const y = pick.below(4);
            device.RSSetViewports([{ TopLeftX: x, TopLeftY: y, Width: 8 - x, Height: 8 - y,
                MinDepth: 0, MaxDepth: 1 }]);
        },
        draw: async()=>draw(),
        clear: async()=>device.ClearRenderTargetView(view.view,
            [pick.float(), pick.float(), pick.float(), 1]),
        readBack: async()=>{
            device.CopyResource(staging, fixed);
            const out = await map(staging, D3D10_MAP.READ);
            answered('read', [...guest.memory.subarray(/** @type {number} */ (out.pData),
                /** @type {number} */ (out.pData) + 64)]);
            staging.Unmap(0);
        },
        occlusion: async()=>{
            query.query.Begin();
            draw();
            query.query.End();
            /** @type {{ value?: any }} */
            const counted = {};
            let hr;
            for (let tries = 0; tries < 64; tries++)
            {
                hr = await query.query.GetData(true, 8, 0, counted);
                if (hr === S_OK)
                {
                    break;
                }
                await idle(gpu);
            }
            answered('GetData', [hr, String(counted.value)]);
        },
        present: async()=>{
            answered('Present', await swapChain.Present(0, 0));
        },
    };
    const names = /** @type {(keyof typeof actions)[]} */ (Object.keys(actions));
    for (let step = 0; step < steps; step++)
    {
        const name = pick.pick(names);
        await actions[name]();
    }
    await swapChain.Present(0, 0);
    await idle(gpu);
    return { answers, reads, divergences };
}

for (const seed of [1, 2, 3, 4, 5])
{
    test(`Direct3D 10 recorded and played elsewhere gives the GPU what drawing itself does,`
        + ` seed ${seed}`, async()=>{
        const own = await run(seed, 160, false);
        const played = await run(seed, 160, true);
        assert.ok(own.reads.length > 0, 'the GPU drew something');
        assert.deepEqual(played.answers, own.answers, 'every answer');
        assert.deepEqual(played.reads, own.reads, 'what every draw read');
        assert.deepEqual(played.divergences, own.divergences);
    });
}
