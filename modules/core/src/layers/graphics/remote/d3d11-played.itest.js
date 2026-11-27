/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A gate for Direct3D 11 drawn elsewhere: the same root Direct3D 10's is
 * (`d3d10/root.js`), its devices made at a feature level, the pipeline set
 * through the immediate context and through a deferred context's command
 * list. A program drawn from a seed runs on a root that draws itself and on
 * one recorded and played at once; every answer, the bytes read back, and
 * what every draw the GPU is given reads must agree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirect3D10 } from '../d3d10/root.js';
import {
    D3D10_BIND, D3D10_CPU_ACCESS, D3D10_MAP, D3D10_PRIMITIVE_TOPOLOGY, D3D10_USAGE,
    D3D_FEATURE_LEVEL, DXGI_FORMAT, IID, S_OK,
} from '../d3d10/constants.js';
import { defaultSwapChainDesc } from '../d3d10/dxgi.js';
import { colouredPixelShader, colouredVertexShader } from '../d3d10/shader-fixtures.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { gpuReads, idle } from '../seam/frames-contract.itest.js';
import { playedAtOnce } from './direct3d.js';
import { playedDirect3D10, recordedDirect3D10 } from './d3d10.js';
import { constantPixelShader, guestMemory, random } from './played-fixtures.js';

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
    /** @type {any} */
    const made = { wantDevice: true, wantContext: true, wantSwapChain: true, device: null,
        context: null, swapChain: null, featureLevel: 0 };
    assert.equal(root.CreateDeviceAndSwapChain11(null, 1, null, 0, null, desc, made), S_OK);
    answered('level', made.featureLevel);
    const { device, context, swapChain } = made;
    /** @type {{ context?: any }} */
    const again = {};
    device.GetImmediateContext?.(again);
    /** @type {{ buffer?: any }} */
    const held = {};
    assert.equal(swapChain.GetBuffer(0, IID.ID3D11Texture2D, held), S_OK);
    /** @type {{ view?: any }} */
    const view = {};
    assert.equal(device.CreateRenderTargetView(held.buffer, null, view), S_OK);

    /** @param {any} bufferDesc @param {any} [data] */
    const buffer = (bufferDesc, data = null)=>{
        /** @type {{ resource?: any }} */
        const out = {};
        assert.equal(device.CreateBuffer({ MiscFlags: 0, ...bufferDesc }, data, out), S_OK);
        return out.resource;
    };
    const dynamic = buffer({ ByteWidth: BUFFER_BYTES, Usage: D3D10_USAGE.DYNAMIC,
        BindFlags: D3D10_BIND.VERTEX_BUFFER, CPUAccessFlags: D3D10_CPU_ACCESS.WRITE });
    const fixed = buffer({ ByteWidth: BUFFER_BYTES, Usage: D3D10_USAGE.DEFAULT,
        BindFlags: D3D10_BIND.VERTEX_BUFFER, CPUAccessFlags: 0 },
    { pSysMem: floatBytes(Array.from({ length: BUFFER_BYTES / 4 }, ()=>pick.float())),
        SysMemPitch: 0, SysMemSlicePitch: 0 });
    const constants = buffer({ ByteWidth: 16, Usage: D3D10_USAGE.DYNAMIC,
        BindFlags: D3D10_BIND.CONSTANT_BUFFER, CPUAccessFlags: D3D10_CPU_ACCESS.WRITE });
    const staging = buffer({ ByteWidth: BUFFER_BYTES, Usage: D3D10_USAGE.STAGING, BindFlags: 0,
        CPUAccessFlags: D3D10_CPU_ACCESS.READ });
    /** @param {string} method @param {Uint8Array} code */
    const shader = (method, code)=>{
        /** @type {{ shader?: any }} */
        const out = {};
        assert.equal(device[method](code, out), S_OK);
        return out.shader;
    };
    const vs = shader('CreateVertexShader', colouredVertexShader());
    const pixelShaders = [shader('CreatePixelShader', colouredPixelShader()),
        shader('CreatePixelShader', constantPixelShader())];
    /** @type {{ layout?: any }} */
    const layout = {};
    assert.equal(device.CreateInputLayout([
        { SemanticName: 'POSITION', SemanticIndex: 0, Format: DXGI_FORMAT.R32G32B32A32_FLOAT,
            InputSlot: 0, AlignedByteOffset: 0, InputSlotClass: 0, InstanceDataStepRate: 0 },
        { SemanticName: 'COLOR', SemanticIndex: 0, Format: DXGI_FORMAT.R32G32B32A32_FLOAT,
            InputSlot: 0, AlignedByteOffset: 16, InputSlotClass: 0, InstanceDataStepRate: 0 },
    ], colouredVertexShader(), layout), S_OK);
    /** @type {{ context?: any }} */
    const deferredOut = {};
    assert.equal(device.CreateDeferredContext(0, deferredOut), S_OK);
    const deferred = deferredOut.context;

    /**
     * The pipeline a frame draws with, set on a context.
     *
     * @param {any} target
     */
    const setUp = target=>{
        target.IASetInputLayout(layout.layout);
        target.VSSetShader(vs);
        target.PSSetShader(pixelShaders[0]);
        target.PSSetConstantBuffers(0, [constants]);
        target.OMSetRenderTargets([view.view], null);
        target.RSSetViewports([{ TopLeftX: 0, TopLeftY: 0, Width: 8, Height: 8, MinDepth: 0,
            MaxDepth: 1 }]);
        target.IASetPrimitiveTopology(D3D10_PRIMITIVE_TOPOLOGY.TRIANGLELIST);
        target.IASetVertexBuffers(0, [dynamic], [STRIDE], [0]);
    };
    setUp(context);

    /** @param {any} resource @param {number} type @returns {Promise<{ pData?: number }>} */
    const map = async(resource, type)=>{
        /** @type {{ pData?: number, rowPitch?: number, bytes?: number }} */
        const out = {};
        const hr = await resource.Map(0, type, 0, out);
        answered('Map', [hr, out.pData, out.rowPitch, out.bytes]);
        assert.equal(hr, S_OK);
        return out;
    };
    /** @param {any} target */
    const draw = target=>{
        const count = 3 * (1 + pick.below(4));
        target.Draw(count, pick.below(VERTICES - count));
    };
    const actions = {
        mapDynamic: async()=>{
            const out = await map(dynamic, pick.pick([D3D10_MAP.WRITE_DISCARD,
                D3D10_MAP.WRITE_NO_OVERWRITE]));
            const first = pick.below(VERTICES - 8);
            guest.store(/** @type {number} */ (out.pData) + first * STRIDE,
                floatBytes(Array.from({ length: STRIDE / 4 }, ()=>pick.float())));
            dynamic.Unmap(0);
        },
        mapConstants: async()=>{
            const out = await map(constants, D3D10_MAP.WRITE_DISCARD);
            guest.store(/** @type {number} */ (out.pData),
                floatBytes([pick.float(), pick.float(), pick.float(), 1]));
            constants.Unmap(0);
        },
        bind: async()=>{
            context.IASetVertexBuffers(0, [pick.pick([dynamic, fixed])], [STRIDE],
                [STRIDE * pick.below(8)]);
            context.PSSetShader(pick.pick(pixelShaders));
        },
        draw: async()=>draw(context),
        clear: async()=>context.ClearRenderTargetView(view.view,
            [pick.float(), pick.float(), pick.float(), 1]),
        // A frame's draws recorded on a deferred context and played on the
        // immediate one, its own pipeline kept or cleared after.
        commandList: async()=>{
            setUp(deferred);
            deferred.PSSetShader(pick.pick(pixelShaders));
            draw(deferred);
            draw(deferred);
            /** @type {{ list?: any }} */
            const list = {};
            answered('Finish', deferred.FinishCommandList(false, list));
            const restore = pick.below(2) === 1;
            context.ExecuteCommandList(list.list, restore);
            list.list.release();
            /** @type {{ shader?: any }} */
            const bound = {};
            context.PSGetShader(bound);
            answered('after', [restore, bound.shader === null]);
            bound.shader?.release();
            if (!restore)
            {
                setUp(context);
            }
        },
        readBack: async()=>{
            context.CopyResource(staging, fixed);
            const out = await map(staging, D3D10_MAP.READ);
            answered('read', [...guest.memory.subarray(/** @type {number} */ (out.pData),
                /** @type {number} */ (out.pData) + 64)]);
            staging.Unmap(0);
        },
        present: async()=>{
            answered('Present', await swapChain.Present(0, 0));
        },
    };
    const names = /** @type {(keyof typeof actions)[]} */ (Object.keys(actions));
    for (let step = 0; step < steps; step++)
    {
        await actions[pick.pick(names)]();
    }
    await swapChain.Present(0, 0);
    await idle(gpu);
    return { answers, reads, divergences, level: made.featureLevel };
}

for (const seed of [1, 2, 3, 4])
{
    test(`Direct3D 11 recorded and played elsewhere gives the GPU what drawing itself does,`
        + ` its command lists too, seed ${seed}`, async()=>{
        const own = await run(seed, 140, false);
        const played = await run(seed, 140, true);
        assert.equal(own.level, D3D_FEATURE_LEVEL.LEVEL_11_0);
        assert.ok(own.reads.length > 0, 'the GPU drew something');
        assert.ok(own.answers.some(line=>line.startsWith('Finish')), 'a command list was played');
        assert.deepEqual(played.answers, own.answers, 'every answer');
        assert.deepEqual(played.reads, own.reads, 'what every draw read');
        assert.deepEqual(played.divergences, own.divergences);
    });
}
