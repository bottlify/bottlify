/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Compute shaders and what they write through, recorded against the fake
 * GPU: the pipeline and group a dispatch is given, the order the GPU's own
 * writes and the program's land in, and what comes back to the processor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3D10_BIND, D3D10_CPU_ACCESS, D3D10_MAP, D3D10_USAGE, D3D11_BIND_UNORDERED_ACCESS,
    D3D11_BUFFER_UAV_FLAG, D3D11_RESOURCE_MISC, D3D_FEATURE_LEVEL, DXGI_FORMAT, S_OK,
} from './constants.js';
import { D3D11CreateDevice } from './device.js';
import { SHADER_KIND, SYSTEM_VALUE } from './dxbc.js';
import { RESOURCE_DIMENSION, RETURN_TYPE } from './sm4.js';
import {
    assemble, atomicIadd, dclGlobalFlags, dclOutput, dclOutputSiv, dclTemps, dclThreadGroup,
    dclUavRaw, dclUavStructured, dclUavTyped, immAtomicAlloc, ishl, l, lu, mov, o, r, ret,
    storeRaw, storeUavTyped, u, vThreadID,
} from './shader-fixtures.js';
import { BINDING } from './wgsl.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

const UAV_BUFFER = 1;
const UAV_TEXTURE2D = 4;

/**
 * A level 11 device over the recording GPU, and its immediate context.
 *
 * @param {(descriptor: any, made: (descriptor: any) => any) => any} [createTexture]
 */
function harness(createTexture){
    const gpu = createFakeDevice();
    /** @type {string[]} */
    const divergences = [];
    const backend = createBackend({ device: gpu.device, queue: gpu.queue,
        presentTo: ()=>{}, now: ()=>0 });
    /** @type {import('./device.js').DeviceRequest11} */
    const out = { wantDevice: true, wantContext: true };
    assert.equal(D3D11CreateDevice(null, 1, null, 0, [D3D_FEATURE_LEVEL.LEVEL_11_0], out, {
        backend,
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
        createTexture: createTexture
            ? (/** @type {any} */ descriptor)=>createTexture(descriptor, gpu.device.createTexture)
            : gpu.device.createTexture,
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
    }), S_OK);
    return { gpu, divergences, device: out.device, context: out.context };
}

/**
 * @param {ReturnType<typeof harness>} h @param {Uint8Array | null} bytes
 * @param {Partial<any>} [desc]
 */
function uavBuffer(h, bytes, desc = {}){
    /** @type {{ resource?: any }} */
    const made = {};
    assert.equal(h.device.CreateBuffer({
        ByteWidth: 64, Usage: D3D10_USAGE.DEFAULT,
        BindFlags: D3D11_BIND_UNORDERED_ACCESS | D3D10_BIND.SHADER_RESOURCE, CPUAccessFlags: 0,
        MiscFlags: 0, MiscFlags11: D3D11_RESOURCE_MISC.BUFFER_ALLOW_RAW_VIEWS,
        StructureByteStride: 0, ...desc,
    }, bytes ? [{ pSysMem: bytes }] : null, made), S_OK);
    const backing = h.gpu.of('createBuffer').filter((/** @type {any} */ call)=>
        call.descriptor.label.startsWith('d3d10:buffer#')).at(-1);
    return { resource: made.resource, gpu: backing.createBuffer };
}

/** @param {ReturnType<typeof harness>} h @param {any} resource @param {any} desc */
function uavOf(h, resource, desc){
    /** @type {{ view?: any }} */
    const made = {};
    assert.equal(h.device.CreateUnorderedAccessView(resource, desc, made), S_OK);
    return made.view;
}

/** @param {ReturnType<typeof harness>} h @param {any[]} instructions */
function computeShader(h, instructions){
    /** @type {{ shader?: any }} */
    const made = {};
    assert.equal(h.device.CreateComputeShader(assemble({
        kind: SHADER_KIND.COMPUTE, major: 5, instructions,
    }), made), S_OK);
    return made.shader;
}

/** Each thread writes its id into the dword it names. */
const WRITE_IDS = [
    dclThreadGroup(4, 1, 1),
    dclUavRaw(0),
    dclTemps(1),
    ishl(r(0, 'x'), vThreadID('x'), lu(2)),
    storeRaw(u(0, 'x'), r(0, 'x'), vThreadID('x')),
    ret(),
];

test('a dispatch runs the translated shader over its grid, the view\'s buffer written as'
    + ' storage and read through a uniform of its range', async()=>{
    const h = harness();
    const buffer = uavBuffer(h, null);
    const view = uavOf(h, buffer.resource, { Format: DXGI_FORMAT.R32_TYPELESS,
        ViewDimension: UAV_BUFFER, FirstElement: 2, NumElements: 8,
        Flags: D3D11_BUFFER_UAV_FLAG.RAW });
    h.context.CSSetShader(computeShader(h, WRITE_IDS), null, 0);
    h.context.CSSetUnorderedAccessViews(0, [view], null);
    h.context.Dispatch(2, 1, 1);
    h.context.Flush();
    await h.device.idle();
    assert.deepEqual(h.divergences, []);
    const pipeline = h.gpu.of('createComputePipeline')[0];
    assert.ok(pipeline, 'a compute pipeline');
    assert.equal(pipeline.descriptor.compute.entryPoint, 'computeMain');
    const [dispatch] = h.gpu.of('dispatchWorkgroups');
    assert.deepEqual(dispatch.grid, [2, 1, 1]);
    assert.equal(dispatch.pipeline, pipeline.createComputePipeline);
    const [storage, range] = dispatch.group.descriptor.entries;
    assert.equal(storage.binding, 288);
    assert.equal(storage.resource.buffer, buffer.gpu, 'the buffer itself');
    assert.equal(range.binding, 352);
    assert.deepEqual([...new Uint32Array(range.resource.buffer.bytes.slice(0, 16).buffer)],
        [DXGI_FORMAT.R32_TYPELESS, 2, 8, 4], 'format, first element, count, element size');
});

test('a copy out of a buffer a shader writes is made by the GPU, and a map of the staging'
    + ' buffer waits for the read back', async()=>{
    const h = harness();
    const buffer = uavBuffer(h, Uint8Array.from({ length: 64 }, (_, index)=>index));
    /** @type {{ resource?: any }} */
    const staging = {};
    assert.equal(h.device.CreateBuffer({ ByteWidth: 64, Usage: D3D10_USAGE.STAGING,
        BindFlags: 0, CPUAccessFlags: D3D10_CPU_ACCESS.READ, MiscFlags: 0 }, null, staging),
    S_OK);
    h.context.Flush();
    await h.device.idle();
    // What a shader wrote there, which the processor never saw.
    buffer.gpu.bytes.fill(0xab, 8, 16);
    h.context.CopyResource(staging.resource, buffer.resource);
    const pending = staging.resource.pendingReadback();
    assert.ok(pending, 'the map waits');
    await pending;
    /** @type {{ data?: Uint8Array | null }} */
    const mapped = {};
    assert.equal(staging.resource.Map(0, D3D10_MAP.READ, 0, mapped), S_OK);
    assert.deepEqual([...(mapped.data ?? []).slice(4, 20)],
        [4, 5, 6, 7, ...new Array(8).fill(0xab), 16, 17, 18, 19]);
    staging.resource.Unmap(0);
});

test('the program\'s bytes for a buffer a shader writes land after the dispatches before them'
    + ' and before those after', async()=>{
    const h = harness();
    const buffer = uavBuffer(h, null);
    const view = uavOf(h, buffer.resource, { Format: DXGI_FORMAT.R32_TYPELESS,
        ViewDimension: UAV_BUFFER, FirstElement: 0, NumElements: 16,
        Flags: D3D11_BUFFER_UAV_FLAG.RAW });
    h.context.CSSetShader(computeShader(h, WRITE_IDS), null, 0);
    h.context.CSSetUnorderedAccessViews(0, [view], null);
    h.context.Dispatch(1, 1, 1);
    h.context.UpdateSubresource(buffer.resource, 0, { left: 4, right: 8, top: 0, bottom: 1,
        front: 0, back: 1 }, Uint8Array.of(9, 9, 9, 9), 0, 0);
    h.context.Dispatch(1, 1, 1);
    h.context.Flush();
    await h.device.idle();
    const order = h.gpu.calls.filter((/** @type {any} */ call)=>call.op === 'dispatchWorkgroups'
        || (call.op === 'copyBufferToBuffer' && call.destination === buffer.gpu))
        .map((/** @type {any} */ call)=>call.op);
    assert.deepEqual(order, ['dispatchWorkgroups', 'copyBufferToBuffer', 'dispatchWorkgroups']);
    const write = h.gpu.of('copyBufferToBuffer').find((/** @type {any} */ call)=>
        call.destination === buffer.gpu);
    assert.equal(write.destinationOffset, 4);
    assert.equal(write.size, 4);
});

test('an append view counts on the GPU from the count its binding gave, and the count is'
    + ' copied by the GPU; its declaration carries no counter flag, as fxc writes an append'
    + ' buffer\'s (test_dispatch_indirect, d3d11.c:25572)', async()=>{
    const h = harness();
    const buffer = uavBuffer(h, null, { MiscFlags11: D3D11_RESOURCE_MISC.BUFFER_STRUCTURED,
        StructureByteStride: 4 });
    const view = uavOf(h, buffer.resource, { Format: DXGI_FORMAT.UNKNOWN,
        ViewDimension: UAV_BUFFER, FirstElement: 0, NumElements: 16,
        Flags: D3D11_BUFFER_UAV_FLAG.APPEND });
    h.context.CSSetShader(computeShader(h, [
        dclThreadGroup(4, 1, 1),
        dclUavStructured(0, 4),
        dclTemps(1),
        immAtomicAlloc(r(0, 'x'), u(0)),
        ret(),
    ]), null, 0);
    h.context.CSSetUnorderedAccessViews(0, [view], [5]);
    h.context.Dispatch(1, 1, 1);
    const target = uavBuffer(h, null);
    h.context.CopyStructureCount(target.resource, 8, view);
    h.context.Flush();
    await h.device.idle();
    assert.deepEqual(h.divergences, []);
    const [dispatch] = h.gpu.of('dispatchWorkgroups');
    const counter = dispatch.group.descriptor.entries.find((/** @type {any} */ entry)=>
        entry.binding === 416).resource.buffer;
    assert.equal(new Uint32Array(counter.bytes.slice(0, 4).buffer)[0], 5, 'the initial count');
    const copy = h.gpu.of('copyBufferToBuffer').find((/** @type {any} */ call)=>
        call.source === counter);
    assert.equal(copy.destination, target.gpu);
    assert.equal(copy.destinationOffset, 8);
});

test('a texture a shader writes is a storage texture, viewed at the view\'s level', async()=>{
    const h = harness();
    /** @type {{ resource?: any }} */
    const texture = {};
    assert.equal(h.device.CreateTexture2D({
        Width: 8, Height: 8, MipLevels: 2, ArraySize: 1, Format: DXGI_FORMAT.R32_FLOAT,
        SampleDesc: { Count: 1, Quality: 0 }, Usage: D3D10_USAGE.DEFAULT,
        BindFlags: D3D11_BIND_UNORDERED_ACCESS, CPUAccessFlags: 0, MiscFlags: 0,
    }, null, texture), S_OK);
    const made = h.gpu.of('createTexture').at(-1);
    assert.ok((made.descriptor.usage & 0x08) !== 0, 'STORAGE_BINDING');
    const view = uavOf(h, texture.resource, { Format: DXGI_FORMAT.R32_FLOAT,
        ViewDimension: UAV_TEXTURE2D, MipSlice: 1 });
    h.context.CSSetShader(computeShader(h, [
        dclThreadGroup(4, 4, 1),
        dclUavTyped(0, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.FLOAT),
        storeUavTyped(u(0, 'xyzw'), vThreadID('xyyy'), lu(1, 0, 0, 0)),
        ret(),
    ]), null, 0);
    h.context.CSSetUnorderedAccessViews(0, [view], null);
    h.context.Dispatch(1, 1, 1);
    h.context.Flush();
    await h.device.idle();
    assert.deepEqual(h.divergences, []);
    const [dispatch] = h.gpu.of('dispatchWorkgroups');
    const written = dispatch.group.descriptor.entries[0].resource;
    assert.equal(written.viewDescriptor.format, 'r32float');
    assert.equal(written.viewDescriptor.dimension, '2d');
    assert.equal(written.viewDescriptor.baseMipLevel, 1);
    const layout = h.gpu.of('createComputePipeline')[0].descriptor.layout.descriptor
        .bindGroupLayouts[0].descriptor.entries[0];
    assert.deepEqual(layout.storageTexture,
        { access: 'write-only', format: 'r32float', viewDimension: '2d' });
});

/** @param {ReturnType<typeof harness>} h @param {number} format @param {number} bind */
function texture2D(h, format, bind, width = 8, height = 4){
    /** @type {{ resource?: any }} */
    const made = {};
    assert.equal(h.device.CreateTexture2D({
        Width: width, Height: height, MipLevels: 1, ArraySize: 1, Format: format,
        SampleDesc: { Count: 1, Quality: 0 }, Usage: D3D10_USAGE.DEFAULT, BindFlags: bind,
        CPUAccessFlags: 0, MiscFlags: 0,
    }, null, made), S_OK);
    return made.resource;
}

test('a texture an atomic is made on is written as the words of its texels in a buffer, given'
    + ' its texels before the dispatch and giving them back after', async()=>{
    const h = harness();
    const texture = texture2D(h, DXGI_FORMAT.R32_UINT, D3D11_BIND_UNORDERED_ACCESS);
    const view = uavOf(h, texture, { Format: DXGI_FORMAT.R32_UINT,
        ViewDimension: UAV_TEXTURE2D, MipSlice: 0 });
    h.context.CSSetShader(computeShader(h, [
        dclThreadGroup(8, 4, 1),
        dclUavTyped(0, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.UINT),
        atomicIadd(u(0, 'x'), vThreadID('xyyy'), lu(1)),
        ret(),
    ]), null, 0);
    h.context.CSSetUnorderedAccessViews(0, [view], null);
    h.context.Dispatch(1, 1, 1);
    h.context.Flush();
    await h.device.idle();
    assert.deepEqual(h.divergences, []);
    const ops = h.gpu.calls.map((/** @type {any} */ call)=>call.op).filter((/** @type {string} */
        op)=>['copyTextureToBuffer', 'dispatchWorkgroups', 'copyBufferToTexture'].includes(op));
    assert.deepEqual(ops, ['copyTextureToBuffer', 'dispatchWorkgroups', 'copyBufferToTexture']);
    const [given] = h.gpu.of('copyTextureToBuffer');
    // Rows padded to 256 bytes, as a copy lays them out.
    assert.equal(given.destination.bytesPerRow, 256);
    assert.deepEqual(given.size, { width: 8, height: 4, depthOrArrayLayers: 1 });
    const [dispatch] = h.gpu.of('dispatchWorkgroups');
    const words = dispatch.group.descriptor.entries.find((/** @type {any} */ entry)=>
        entry.binding === BINDING.UAV).resource;
    assert.equal(words.buffer, given.destination.buffer, 'the shader writes the words');
    assert.equal(h.gpu.of('copyBufferToTexture').at(-1).source.buffer, words.buffer);
});

test('a pixel shader that asks for early depth tests tests itself against the depth buffer,'
    + ' attached read-only, a clear waiting for it made first', async()=>{
    const h = harness();
    const target = texture2D(h, DXGI_FORMAT.R8G8B8A8_UNORM, D3D10_BIND.RENDER_TARGET, 4, 4);
    const depth = texture2D(h, DXGI_FORMAT.D32_FLOAT, D3D10_BIND.DEPTH_STENCIL, 4, 4);
    const counted = texture2D(h, DXGI_FORMAT.R32_SINT, D3D11_BIND_UNORDERED_ACCESS, 1, 1);
    /** @type {{ view?: any, shader?: any, state?: any }} */
    const made = {};
    assert.equal(h.device.CreateRenderTargetView(target, null, made), S_OK);
    const rtv = made.view;
    assert.equal(h.device.CreateDepthStencilView(depth, null, made), S_OK);
    const dsv = made.view;
    const uav = uavOf(h, counted, null);
    const POSITION = { name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 };
    assert.equal(h.device.CreateVertexShader(assemble({ kind: SHADER_KIND.VERTEX, outputs:
        [POSITION], instructions: [dclOutputSiv(o(0), SYSTEM_VALUE.POSITION),
        mov(o(0), l(0, 0, 0.5, 1)), ret()] }), made), S_OK);
    h.context.VSSetShader(made.shader, null, 0);
    assert.equal(h.device.CreatePixelShader(assemble({ kind: SHADER_KIND.PIXEL, major: 5,
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
        instructions: [dclGlobalFlags(1 | 4),
            dclUavTyped(1, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.SINT), dclOutput(o(0)),
            atomicIadd(u(1, 'x'), lu(0, 0, 0, 0), lu(1)), mov(o(0), l(1, 1, 1, 1)), ret()] }),
    made), S_OK);
    h.context.PSSetShader(made.shader, null, 0);
    const KEEP = { StencilFailOp: 1, StencilDepthFailOp: 1, StencilPassOp: 1, StencilFunc: 8 };
    assert.equal(h.device.CreateDepthStencilState({ DepthEnable: 1, DepthWriteMask: 0,
        DepthFunc: 4, StencilEnable: 0, StencilReadMask: 255, StencilWriteMask: 255,
        FrontFace: KEEP, BackFace: KEEP }, made), S_OK);
    h.context.OMSetDepthStencilState(made.state, 0);
    h.context.RSSetViewports([{ TopLeftX: 0, TopLeftY: 0, Width: 4, Height: 4, MinDepth: 0,
        MaxDepth: 1 }]);
    h.context.OMSetRenderTargetsAndUnorderedAccessViews(1, [rtv], dsv, 1, 1, [uav], null);
    h.context.IASetPrimitiveTopology(4);
    h.context.ClearDepthStencilView(dsv, 1, 0.6, 0);
    h.context.Draw(3, 0);
    h.context.Flush();
    await h.device.idle();
    assert.deepEqual(h.divergences, []);
    const passes = h.gpu.of('beginRenderPass').map((/** @type {any} */ call)=>
        call.descriptor.depthStencilAttachment);
    assert.equal(passes.length, 2);
    assert.equal(passes[0].depthLoadOp, 'clear', 'the clear, by a pass of its own');
    assert.equal(passes[0].depthClearValue, 0.6);
    assert.equal(passes[1].depthReadOnly, true);
    const group = h.gpu.of('setBindGroup').filter((/** @type {any} */ call)=>call.index === 1)
        .at(-1).group;
    const tested = group.descriptor.entries.find((/** @type {any} */ entry)=>
        entry.binding === BINDING.EARLY_DEPTH).resource;
    assert.equal(tested.viewDescriptor.aspect, 'depth-only');
    assert.equal(h.gpu.count('draw'), 1);
});

test('from level 11_0 a viewport corner left of or above the target is floored to a whole'
    + ' pixel (test_negative_viewports)', async()=>{
    const h = harness();
    const target = texture2D(h, DXGI_FORMAT.R8G8B8A8_UNORM, D3D10_BIND.RENDER_TARGET, 4, 4);
    /** @type {{ view?: any, shader?: any }} */
    const made = {};
    assert.equal(h.device.CreateRenderTargetView(target, null, made), S_OK);
    h.context.OMSetRenderTargets([made.view], null);
    const POSITION = { name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 };
    assert.equal(h.device.CreateVertexShader(assemble({ kind: SHADER_KIND.VERTEX, outputs:
        [POSITION], instructions: [dclOutputSiv(o(0), SYSTEM_VALUE.POSITION),
        mov(o(0), l(0, 0, 0.5, 1)), ret()] }), made), S_OK);
    h.context.VSSetShader(made.shader, null, 0);
    h.context.IASetPrimitiveTopology(4);
    h.context.RSSetViewports([{ TopLeftX: -0.4, TopLeftY: -1 / 128, Width: 4, Height: 4,
        MinDepth: 0, MaxDepth: 1 }]);
    h.context.Draw(3, 0);
    h.context.RSSetViewports([{ TopLeftX: 0.25, TopLeftY: 0, Width: 4, Height: 4,
        MinDepth: 0, MaxDepth: 1 }]);
    h.context.Draw(3, 0);
    h.context.Flush();
    await h.device.idle();
    const rects = h.gpu.of('setViewport').map((/** @type {any} */ call)=>call.rect.slice(0, 2));
    assert.deepEqual(rects.at(-2), [-1, -1]);
    assert.deepEqual(rects.at(-1), [0.25, 0], 'a corner inside the target is kept as it is');
});

test('a command list keeps the bytes it was handed: the buffer they came in may be gone when'
    + ' it plays', async()=>{
    // In the graphics worker a deferred context's UpdateSubresource and its
    // unmapped bytes arrive as views of a message the channel takes back;
    // the list is played frames later.
    const h = harness();
    const { resource } = uavBuffer(h, null);
    /** @type {{ context?: any, list?: any }} */
    const made = {};
    assert.equal(h.device.CreateDeferredContext(0, made), S_OK);
    const deferred = made.context;
    const written = Uint8Array.from({ length: 64 }, (_, at)=>at + 1);
    const mapped = Uint8Array.from({ length: 64 }, (_, at)=>200 - at);
    deferred.UpdateSubresource(resource, 0, null, written, 64, 64);
    deferred.WriteMapped(resource, mapped);
    assert.equal(deferred.FinishCommandList(false, made), S_OK);
    // The messages go back to where they came from.
    structuredClone(written.buffer, { transfer: [written.buffer] });
    structuredClone(mapped.buffer, { transfer: [mapped.buffer] });
    assert.equal(written.length, 0, 'detached');
    const before = h.gpu.of('writeBuffer').length;
    h.context.ExecuteCommandList(made.list, false);
    h.context.Flush();
    await h.device.idle();
    const writes = h.gpu.of('writeBuffer').slice(before);
    assert.equal(writes.length, 2);
    assert.deepEqual([...writes[0].bytes.slice(0, 4)], [1, 2, 3, 4]);
    assert.deepEqual([...writes[1].bytes.slice(0, 4)], [200, 199, 198, 197]);
    made.list.release();
    deferred.release();
});

test('a command list finished keeping its context\'s bindings starts from them where it plays;'
    + ' one with nowhere to go is dropped (test_deferred_context_rendering)', async()=>{
    const h = harness();
    const target = texture2D(h, DXGI_FORMAT.R8G8B8A8_UNORM, D3D10_BIND.RENDER_TARGET, 4, 4);
    /** @type {{ view?: any, views?: any[], shader?: any, context?: any, list?: any }} */
    const made = {};
    assert.equal(h.device.CreateRenderTargetView(target, null, made), S_OK);
    const rtv = made.view;
    const POSITION = { name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 };
    assert.equal(h.device.CreateVertexShader(assemble({ kind: SHADER_KIND.VERTEX, outputs:
        [POSITION], instructions: [dclOutputSiv(o(0), SYSTEM_VALUE.POSITION),
        mov(o(0), l(0, 0, 0.5, 1)), ret()] }), made), S_OK);
    const vs = made.shader;
    assert.equal(h.device.CreateDeferredContext(0, made), S_OK);
    const deferred = made.context;
    deferred.OMSetRenderTargets([rtv], null);
    deferred.VSSetShader(vs, null, 0);
    deferred.IASetPrimitiveTopology(4);
    deferred.RSSetViewports([{ TopLeftX: 0, TopLeftY: 0, Width: 4, Height: 4, MinDepth: 0,
        MaxDepth: 1 }]);
    assert.equal(deferred.FinishCommandList(true, made), S_OK);
    made.list.release();
    deferred.Draw(3, 0);
    assert.equal(deferred.FinishCommandList(false, made), S_OK);
    const drawing = made.list;
    deferred.Draw(3, 0);
    assert.equal(deferred.FinishCommandList(false, null), 0x8000ffff, 'E_UNEXPECTED');
    assert.equal(deferred.FinishCommandList(false, made), S_OK);
    const dropped = made.list;
    assert.deepEqual(dropped.calls, [], 'what was recorded went with the refused list');
    h.context.ExecuteCommandList(drawing, false);
    h.context.ExecuteCommandList(dropped, false);
    h.context.Flush();
    await h.device.idle();
    assert.equal(h.gpu.count('draw'), 1, 'drawn with the bindings the list started from');
    // A list played into a deferred context leaves its bindings cleared,
    // unless it is asked to keep them (test_deferred_context_state).
    deferred.OMSetRenderTargets([rtv], null);
    deferred.ExecuteCommandList(dropped, true);
    deferred.OMGetRenderTargets(1, made, null);
    assert.equal(made.views?.[0], rtv);
    deferred.ExecuteCommandList(dropped, false);
    /** @type {any} */
    const after = {};
    deferred.OMGetRenderTargets(1, after, null);
    assert.equal(after.views?.[0], null);
    drawing.release();
    dropped.release();
});

test('a clear of a buffer view writes its range in turn; of a texture, by a dispatch over it',
    async()=>{
        const h = harness();
        const buffer = uavBuffer(h, null);
        const view = uavOf(h, buffer.resource, { Format: DXGI_FORMAT.R8G8B8A8_UINT,
            ViewDimension: UAV_BUFFER, FirstElement: 1, NumElements: 2, Flags: 0 });
        h.context.ClearUnorderedAccessViewUint(view, [1, 2, 0x103, 4]);
        /** @type {{ resource?: any }} */
        const texture = {};
        assert.equal(h.device.CreateTexture2D({
            Width: 16, Height: 8, MipLevels: 1, ArraySize: 2, Format: DXGI_FORMAT.R8G8B8A8_UNORM,
            SampleDesc: { Count: 1, Quality: 0 }, Usage: D3D10_USAGE.DEFAULT,
            BindFlags: D3D11_BIND_UNORDERED_ACCESS, CPUAccessFlags: 0, MiscFlags: 0,
        }, null, texture), S_OK);
        const textureView = uavOf(h, texture.resource, { Format: DXGI_FORMAT.R8G8B8A8_UNORM,
            ViewDimension: 5, MipSlice: 0, FirstArraySlice: 0, ArraySize: 2 });
        h.context.ClearUnorderedAccessViewFloat(textureView, [1, 0, 0.5, 1]);
        h.context.ClearUnorderedAccessViewFloat(view, [1, 0, 0, 0]);
        h.context.Flush();
        await h.device.idle();
        assert.deepEqual(h.divergences, ['Direct3D 10: a Float clear of a buffer view in format'
            + ` ${DXGI_FORMAT.R8G8B8A8_UINT} writes nothing`]);
        const write = h.gpu.of('copyBufferToBuffer').find((/** @type {any} */ call)=>
            call.destination === buffer.gpu);
        assert.equal(write.destinationOffset, 4);
        assert.deepEqual([...write.source.bytes.slice(0, write.size)],
            [1, 2, 3, 4, 1, 2, 3, 4]);
        const [clear] = h.gpu.of('dispatchWorkgroups');
        assert.deepEqual(clear.grid, [2, 1, 2]);
        const value = clear.group.descriptor.entries[1].resource.buffer;
        // Converted to the format's eight bits, as the clear stores it.
        assert.deepEqual([...new Float32Array(value.bytes.slice(0, 16).buffer)],
            [1, 0, Math.fround(128 / 255), 1]);
    });

test('a texture the GPU cannot keep is cleared through a view in its own bytes, each slice of'
    + ' it (test_clear_image_unordered_access_view)', async()=>{
    // The device refuses the floats R16G16_UNORM is kept in without
    // texture-formats-tier1: the texture lives in its bytes alone.
    const h = harness((descriptor, made)=>{
        if (descriptor.format === 'rg32float')
        {
            throw new TypeError('rg32float refused');
        }
        return made(descriptor);
    });
    const format = DXGI_FORMAT.R16G16_UNORM;
    const base = { Width: 4, Height: 2, MipLevels: 2, Format: format,
        Usage: D3D10_USAGE.DEFAULT, BindFlags: D3D11_BIND_UNORDERED_ACCESS, CPUAccessFlags: 0,
        MiscFlags: 0 };
    /** @param {boolean} volume @param {any} viewDesc @param {boolean} float */
    const cleared = async(volume, viewDesc, float)=>{
        /** @type {{ resource?: any }} */
        const texture = {};
        /** @type {{ resource?: any }} */
        const staging = {};
        const create = (/** @type {any} */ desc, /** @type {any} */ out)=>(volume
            ? h.device.CreateTexture3D({ ...desc, Depth: 3 }, null, out)
            : h.device.CreateTexture2D({ ...desc, ArraySize: 3,
                SampleDesc: { Count: 1, Quality: 0 } }, null, out));
        assert.equal(create(base, texture), S_OK);
        assert.equal(create({ ...base, Usage: D3D10_USAGE.STAGING, BindFlags: 0,
            CPUAccessFlags: 0x20000 }, staging), S_OK);
        const view = uavOf(h, texture.resource, { Format: format, ...viewDesc });
        if (float)
        {
            h.context.ClearUnorderedAccessViewFloat(view, [0.5, 1, 0, 0]);
        }
        else
        {
            h.context.ClearUnorderedAccessViewUint(view, [1, 2, 3, 4]);
        }
        h.context.CopyResource(staging.resource, texture.resource);
        /** @type {number[][]} */
        const slices = [];
        for (let slice = 0; slice < 3; slice++)
        {
            /** @type {{ data?: Uint8Array, rowPitch?: number, depthPitch?: number }} */
            const mapped = {};
            const subresource = volume ? 0 : slice * 2;
            assert.equal(await staging.resource.Map(subresource, 1, 0, mapped), S_OK);
            const at = volume ? slice * (mapped.depthPitch ?? 0) : 0;
            const words = new Uint32Array(/** @type {Uint8Array} */ (mapped.data).slice(at,
                at + (mapped.rowPitch ?? 0) * 2).buffer);
            slices.push([words[0], words[3], words[(mapped.rowPitch ?? 0) / 4 + 3]]);
            staging.resource.Unmap(subresource);
        }
        return slices;
    };
    const half = 0xffff8000;
    assert.deepEqual(await cleared(false, { ViewDimension: 4, MipSlice: 0 }, true),
        [[half, half, half], [0, 0, 0], [0, 0, 0]], 'a 2D view clears its one layer');
    assert.deepEqual(await cleared(false, { ViewDimension: 5, MipSlice: 0, FirstArraySlice: 1,
        ArraySize: 2 }, false), [[0, 0, 0], [0x20001, 0x20001, 0x20001],
        [0x20001, 0x20001, 0x20001]], 'an array view its layers');
    assert.deepEqual(await cleared(true, { ViewDimension: 8, MipSlice: 0, FirstWSlice: 0,
        WSize: 2 }, true), [[half, half, half], [half, half, half], [0, 0, 0]],
    'a volume view its depth slices');
    assert.ok(!h.divergences.some(detail=>/writes nothing/.test(detail)), h.divergences.join());
});

test('DispatchIndirect from a buffer a shader writes reads its grid on the GPU', async()=>{
    const h = harness();
    const args = uavBuffer(h, null, { MiscFlags11: D3D11_RESOURCE_MISC.DRAWINDIRECT_ARGS });
    assert.ok((h.gpu.of('createBuffer').find((/** @type {any} */ call)=>
        call.createBuffer === args.gpu).descriptor.usage & 0x100) !== 0, 'INDIRECT');
    h.context.CSSetShader(computeShader(h, WRITE_IDS), null, 0);
    h.context.DispatchIndirect(args.resource, 12);
    h.context.Flush();
    await h.device.idle();
    const [dispatch] = h.gpu.of('dispatchWorkgroups');
    assert.deepEqual(dispatch.indirect, { buffer: args.gpu, offset: 12 });
});

test('a texture the device refuses on the spot is kept in memory and said, and the device goes'
    + ' on', ()=>{
    const h = harness((descriptor, made)=>{
        if (descriptor.format === 'rg16float')
        {
            throw new TypeError('rg16float refused');
        }
        return made(descriptor);
    });
    /** @type {{ resource?: any }} */
    const texture = {};
    assert.equal(h.device.CreateTexture2D({
        Width: 4, Height: 4, MipLevels: 1, ArraySize: 1, Format: DXGI_FORMAT.R16G16_FLOAT,
        SampleDesc: { Count: 1, Quality: 0 }, Usage: D3D10_USAGE.DEFAULT,
        BindFlags: D3D10_BIND.SHADER_RESOURCE, CPUAccessFlags: 0, MiscFlags: 0,
    }, null, texture), S_OK);
    assert.ok(h.divergences.some(line=>line.includes('lost: a rg16float texture cannot be made')),
        h.divergences.join(' / '));
});
