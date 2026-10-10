/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D 10 seam, driven the way a guest drives it: through the
 * bridge's own vtable publisher, by slot number, over a flat buffer standing in
 * for guest memory.
 *
 * What is checked is translation and nothing else -- the object model and the
 * renderer have their own tests. A structure is read and written at the
 * offsets the header gives; an out-parameter is written when the call succeeded
 * and cleared when it failed; an interface handed back is the pointer the
 * program already holds when the object is the same object; a map hands the
 * program guest memory and the unmap reads it back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVtables } from '../../bridge/internal/vtable.js';
import { createPublisher } from './com.js';
import {
    ID3D10BLENDSTATE1_SLOTS, ID3D10BLOB_SLOTS, ID3D10BUFFER_SLOTS, ID3D10DEVICE1_SLOTS,
    ID3D10DEVICE_SLOTS, ID3D10MULTITHREAD_SLOTS, ID3D10SHADERRESOURCEVIEW1_SLOTS,
    ID3D10STATE_SLOTS,
    ID3D10QUERY_SLOTS, ID3D10SHADERREFLECTIONCONSTANTBUFFER_SLOTS,
    ID3D10SHADERREFLECTIONTYPE_SLOTS, ID3D10SHADERREFLECTIONVARIABLE_SLOTS,
    ID3D10SHADERREFLECTION_SLOTS, ID3D10STATEBLOCK_SLOTS, ID3D10TEXTURE_SLOTS,
    ID3D10VIEW_SLOTS, IDXGIADAPTER1_SLOTS, IDXGIADAPTER_SLOTS, IDXGIDEVICE1_SLOTS,
    IDXGIDEVICE_SLOTS, IDXGIFACTORY1_SLOTS, IDXGIFACTORY_SLOTS, IDXGIOUTPUT_SLOTS,
    IDXGIRESOURCE_SLOTS, IDXGISURFACE_SLOTS, IDXGISWAPCHAIN_SLOTS, createDirect3D10Seam,
} from './d3d10.js';
import {
    D3D10_BIND, D3D10_CPU_ACCESS, D3D10_DRIVER_TYPE, D3D10_MAP, D3D10_PRIMITIVE_TOPOLOGY,
    D3D10_MAP_FLAG_DO_NOT_WAIT, D3D10_QUERY, D3D10_RESOURCE_MISC, D3D10_SDK_VERSION, D3D10_USAGE,
    DXGI_ERROR_INVALID_CALL, DXGI_ERROR_UNSUPPORTED, DXGI_FORMAT,
    DXGI_SWAP_EFFECT, DXGI_USAGE, E_INVALIDARG, IID, S_OK,
} from '../d3d10/constants.js';
import { DXGI_SWAP_CHAIN_DESC, writeSwapChainDesc } from '../d3d10/structs.js';
import {
    assemble, constantBufferShader, dclInputSiv, dclOutputSiv, o, passThroughVertexShader, ret,
    solidPixelShader, utof, v as input,
} from '../d3d10/shader-fixtures.js';
import { COMPONENT_TYPE, SHADER_KIND, SYSTEM_VALUE } from '../d3d10/dxbc.js';
import { createBackend } from '../webgpu/backend.js';
import { FX_KIND, effectBinary } from '../d3d10/effect-fixtures.js';
import { CONSTANT_TYPE } from '../d3d10/effect.js';
import { D3D10_DST, STATE_BLOCK_MASK_SIZE, stateBlockMask } from '../d3d10/stateblock.js';
import { containerOf } from '../d3d10/reflection.js';
import {
    EFFECT_VARIABLE_INTERFACES, ID3D10EFFECTPASS_SLOTS, ID3D10EFFECTTECHNIQUE_SLOTS,
    ID3D10EFFECTTYPE_SLOTS, ID3D10EFFECTVARIABLE_SLOTS, ID3D10EFFECT_SLOTS,
} from './d3d10-effect.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { createGraphicsLibraries } from './exports.js';

const E_NOTIMPL = 0x80004001;

/** @param {[string, number][]} slots @param {string} name */
const slot = (slots, name)=>{
    const index = slots.findIndex(([entry])=>entry === name);
    assert.ok(index >= 0, `${name} is a slot`);
    return 3 + index;
};

/** A flat address space with the bridge's vtable publisher over it. */
function machine(){
    const bytes = new Uint8Array(4 << 20);
    let next = 0x100;

    /** @param {number} address @param {number} length */
    const readBytes = (address, length)=>bytes.slice(address, address + length);
    /** @param {number} address @param {Uint8Array} value */
    const writeBytes = (address, value)=>{
        bytes.set(value, address);
    };
    const memory = {
        readBytes,
        writeBytes,
        /** @param {number} address */
        readU32: address=>{
            const b = readBytes(address, 4);
            return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
        },
        /** @param {number} address @param {number} value */
        writeU32: (address, value)=>writeBytes(address, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ])),
    };
    /** @type {Map<number, any>} */
    const registered = new Map();
    let nextTrap = 1;
    /** @param {number} size */
    const allocate = size=>{
        const at = next;
        next += (size + 16) & ~15;
        return at;
    };
    const vtables = createVtables({
        memory,
        /** @param {string} name @param {any} fn */
        register: (name, fn)=>{
            const id = nextTrap++;
            registered.set(id, { name, fn });
            return id;
        },
        heap: { allocate },
    });
    return {
        memory,
        allocate,
        services: { readMemory: readBytes, writeMemory: writeBytes },
        /** @param {any} object @param {string} id */
        publishInterface: (object, id)=>vtables.publish(object, id),
        /** @param {any} object @param {string} id */
        unpublishInterface: (object, id)=>vtables.unpublish(object, id),
        /** @param {number} pointer @param {number} index @param {number[]} args */
        call(pointer, index, args = []){
            const table = memory.readU32(pointer);
            const entry = registered.get(memory.readU32(table + index * 4));
            assert.ok(entry, `slot ${index} has an implementation`);
            return entry.fn.handler([pointer, ...args]) >>> 0;
        },
        /**
         * A call whose answer may be a promise the bridge would park the
         * caller on: awaited here as the caller would be resumed.
         *
         * @param {number} pointer @param {number} index @param {number[]} args
         */
        async callParked(pointer, index, args = []){
            const table = memory.readU32(pointer);
            const entry = registered.get(memory.readU32(table + index * 4));
            assert.ok(entry, `slot ${index} has an implementation`);
            return (await entry.fn.handler([pointer, ...args])) >>> 0;
        },
        /** @param {number} pointer @param {number} index */
        argBytesOf(pointer, index){
            const table = memory.readU32(pointer);
            return registered.get(memory.readU32(table + index * 4)).fn.argBytes;
        },
        /** @param {number[]} dwords @returns {number} where they were placed */
        place(dwords){
            const at = allocate(Math.max(4, dwords.length * 4));
            dwords.forEach((dword, index)=>memory.writeU32(at + index * 4, dword));
            return at;
        },
        /** @param {Uint8Array} data @returns {number} */
        placeBytes(data){
            const at = allocate(Math.max(4, data.length));
            writeBytes(at, data);
            return at;
        },
        /** @param {string} text @returns {number} a NUL-terminated string */
        placeString(text){
            return this.placeBytes(Uint8Array.from([...[...text].map(c=>c.charCodeAt(0)), 0]));
        },
        /** @param {string} guid @returns {number} */
        placeGuid(guid){
            const hex = guid.replace(/[{}-]/g, '');
            const data1 = parseInt(hex.slice(0, 8), 16);
            const data2 = parseInt(hex.slice(8, 12), 16);
            const data3 = parseInt(hex.slice(12, 16), 16);
            const tail = [];
            for (let index = 16; index < 32; index += 2)
            {
                tail.push(parseInt(hex.slice(index, index + 2), 16));
            }
            return this.placeBytes(Uint8Array.from([
                data1 & 0xff, data1 >>> 8 & 0xff, data1 >>> 16 & 0xff, data1 >>> 24 & 0xff,
                data2 & 0xff, data2 >>> 8, data3 & 0xff, data3 >>> 8, ...tail,
            ]));
        },
    };
}

/** @param {number[]} floats */
const floatBits = floats=>[...new Uint32Array(Float32Array.from(floats).buffer)];

/**
 * The whole assembly as a program reaches it, over a recording GPU.
 */
function seamed(){
    const box = machine();
    const gpu = createFakeDevice();
    /** @type {any[]} */
    const presented = [];
    /** @type {string[]} */
    const divergences = [];
    const backend = createBackend({
        device: gpu.device,
        queue: gpu.queue,
        presentTo: frame=>presented.push(frame),
        now: ()=>0,
    });
    const publisher = createPublisher({
        publishInterface: box.publishInterface,
        unpublishInterface: box.unpublishInterface,
    });
    const seam = createDirect3D10Seam({
        publisher,
        memory: box.services,
        allocate: box.allocate,
        deviceOptions: ()=>({
            backend,
            createSampler: descriptor=>({ kind: 'sampler', descriptor }),
            createTexture: gpu.device.createTexture,
            divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
        }),
    });
    const d3d10 = seam.libraries['D3D10.dll'];
    const dxgi = seam.libraries['DXGI.dll'];

    /**
     * A device and a swap chain through the combined entry point.
     *
     * @param {{ width?: number, height?: number }} [options]
     */
    const createDeviceAndSwapChain = (options = {})=>{
        const descAt = box.allocate(DXGI_SWAP_CHAIN_DESC.SIZE);
        writeSwapChainDesc(box.services, descAt, {
            bufferDesc: {
                width: options.width ?? 8,
                height: options.height ?? 8,
                refreshNumerator: 60,
                refreshDenominator: 1,
                format: DXGI_FORMAT.R8G8B8A8_UNORM,
                scanlineOrdering: 0,
                scaling: 0,
            },
            sampleDesc: { count: 1, quality: 0 },
            bufferUsage: DXGI_USAGE.RENDER_TARGET_OUTPUT,
            bufferCount: 1,
            outputWindow: 0x1234,
            windowed: true,
            swapEffect: DXGI_SWAP_EFFECT.DISCARD,
            flags: 0,
        });
        const chainAt = box.place([0xdeadbeef]);
        const deviceAt = box.place([0xdeadbeef]);
        const hr = d3d10.D3D10CreateDeviceAndSwapChain.handler([
            0, D3D10_DRIVER_TYPE.HARDWARE, 0, 0, D3D10_SDK_VERSION, descAt, chainAt, deviceAt,
        ]) >>> 0;
        assert.equal(hr, S_OK);
        return {
            device: box.memory.readU32(deviceAt),
            swapChain: box.memory.readU32(chainAt),
        };
    };

    return {
        box, gpu, presented, divergences, publisher, seam, d3d10, dxgi, createDeviceAndSwapChain,
        /** @param {number} device @param {string} name @param {number[]} args */
        device: (device, name, args)=>box.call(device, slot(ID3D10DEVICE_SLOTS, name), args),
        /** @param {number} chain @param {string} name @param {number[]} args */
        swapChain: (chain, name, args)=>box.call(chain, slot(IDXGISWAPCHAIN_SLOTS, name), args),
    };
}

test('the device vtable has ninety-five slots after IUnknown, each with its argument bytes',
    ()=>{
        assert.equal(ID3D10DEVICE_SLOTS.length, 95);
        const h = seamed();
        const { device } = h.createDeviceAndSwapChain();
        assert.equal(h.box.argBytesOf(device, slot(ID3D10DEVICE_SLOTS, 'Draw')), 12);
        assert.equal(h.box.argBytesOf(device, slot(ID3D10DEVICE_SLOTS, 'IASetVertexBuffers')), 24);
        assert.equal(h.box.argBytesOf(device, slot(ID3D10DEVICE_SLOTS, 'CopySubresourceRegion')),
            36);
        assert.equal(h.box.argBytesOf(device, slot(ID3D10DEVICE_SLOTS, 'GetTextFilterSize')), 12);
        assert.equal(h.box.argBytesOf(device,
            slot(ID3D10DEVICE_SLOTS, 'CreateGeometryShaderWithStreamOutput')), 28,
        'bytecode, its length, the declaration, its entry count, the stride and the out');
        assert.equal(slot(ID3D10DEVICE_SLOTS, 'CreateBuffer'), 3 + 68);
        assert.equal(slot(ID3D10DEVICE_SLOTS, 'GetTextFilterSize'), 3 + 94);
    });

test('the combined entry point hands back a device and a swap chain, and either can be'
    + ' declined', ()=>{
    const h = seamed();
    const { device, swapChain } = h.createDeviceAndSwapChain();
    assert.notEqual(device, 0);
    assert.notEqual(swapChain, 0);
    assert.equal(h.device(device, 'GetCreationFlags', []), 0);
    assert.equal(h.device(device, 'GetDeviceRemovedReason', []), S_OK);

    // The swap chain's device is the one the program was handed.
    const out = h.box.place([0]);
    assert.equal(h.swapChain(swapChain, 'GetDevice', [h.box.placeGuid(IID.ID3D10Device), out]),
        S_OK);
    assert.equal(h.box.memory.readU32(out), device, 'the same pointer: the same object');

    // A wrong SDK version clears both pointers and fails.
    const chainAt = h.box.place([0xdeadbeef]);
    const deviceAt = h.box.place([0xdeadbeef]);
    assert.equal(h.d3d10.D3D10CreateDeviceAndSwapChain.handler([
        0, D3D10_DRIVER_TYPE.HARDWARE, 0, 0, 7, 0, chainAt, deviceAt,
    ]) >>> 0, E_INVALIDARG);
    assert.equal(h.box.memory.readU32(chainAt), 0);
    assert.equal(h.box.memory.readU32(deviceAt), 0);
});

test('the first frame: a back buffer, a view, a clear and a present reach the GPU', async()=>{
    const h = seamed();
    const { device, swapChain } = h.createDeviceAndSwapChain({ width: 4, height: 4 });

    const bufferAt = h.box.place([0]);
    assert.equal(h.swapChain(swapChain, 'GetBuffer',
        [0, h.box.placeGuid(IID.ID3D10Texture2D), bufferAt]), S_OK);
    const buffer = h.box.memory.readU32(bufferAt);
    assert.notEqual(buffer, 0);

    // The buffer's description, at the header's offsets: width, height, ...
    const descAt = h.box.allocate(0x2c);
    h.box.call(buffer, slot(ID3D10TEXTURE_SLOTS, 'GetDesc'), [descAt]);
    assert.equal(h.box.memory.readU32(descAt), 4, 'Width');
    assert.equal(h.box.memory.readU32(descAt + 4), 4, 'Height');
    assert.equal(h.box.memory.readU32(descAt + 0x10), DXGI_FORMAT.R8G8B8A8_UNORM, 'Format');
    assert.equal(h.box.memory.readU32(descAt + 0x14), 1, 'SampleDesc.Count');
    assert.equal(h.box.memory.readU32(descAt + 0x20), D3D10_BIND.RENDER_TARGET, 'BindFlags');

    const viewAt = h.box.place([0]);
    assert.equal(h.device(device, 'CreateRenderTargetView', [buffer, 0, viewAt]), S_OK);
    const view = h.box.memory.readU32(viewAt);
    h.device(device, 'OMSetRenderTargets', [1, h.box.place([view]), 0]);
    h.device(device, 'ClearRenderTargetView', [view, h.box.place(floatBits([0.2, 0.4, 0.6, 1]))]);
    assert.equal(h.swapChain(swapChain, 'Present', [0, 0]), S_OK);
    await /** @type {any} */ (h.publisher.objectAt(device)).idle();

    const passes = h.gpu.of('beginRenderPass');
    assert.equal(passes.length, 1);
    assert.deepEqual(passes[0].descriptor.colorAttachments[0].clearValue,
        { r: 0.20000000298023224, g: 0.4000000059604645, b: 0.6000000238418579, a: 1 });
    assert.equal(h.presented.length, 1);
    assert.deepEqual(h.divergences, []);

    // What was bound is what comes back, as the same pointer.
    const boundAt = h.box.place([0xdeadbeef]);
    h.device(device, 'OMGetRenderTargets', [1, boundAt, 0]);
    assert.equal(h.box.memory.readU32(boundAt), view);
});

test('a triangle: buffer, layout and shaders from guest memory draw through the seam',
    async()=>{
        const h = seamed();
        const { device, swapChain } = h.createDeviceAndSwapChain();
        const bufferAt = h.box.place([0]);
        h.swapChain(swapChain, 'GetBuffer', [0, h.box.placeGuid(IID.ID3D10Texture2D), bufferAt]);
        const viewAt = h.box.place([0]);
        h.device(device, 'CreateRenderTargetView', [h.box.memory.readU32(bufferAt), 0, viewAt]);
        const view = h.box.memory.readU32(viewAt);

        const vertices = floatBits([
            -0.75, 0.75, 0.5, 1, 0.75, 0.75, 0.5, 1, -0.75, -0.25, 0.5, 1,
        ]);
        const verticesAt = h.box.place(vertices);
        const bufferDesc = h.box.place([48, D3D10_USAGE.IMMUTABLE, D3D10_BIND.VERTEX_BUFFER, 0, 0]);
        const initial = h.box.place([verticesAt, 0, 0]);
        const vertexBufferAt = h.box.place([0]);
        assert.equal(h.device(device, 'CreateBuffer', [bufferDesc, initial, vertexBufferAt]), S_OK);
        const vertexBuffer = h.box.memory.readU32(vertexBufferAt);

        const vsBytes = passThroughVertexShader();
        const vsAt = h.box.placeBytes(vsBytes);
        const element = h.box.place([
            h.box.placeString('POSITION'), 0, DXGI_FORMAT.R32G32B32A32_FLOAT, 0, 0, 0, 0,
        ]);
        const layoutAt = h.box.place([0]);
        assert.equal(h.device(device, 'CreateInputLayout',
            [element, 1, vsAt, vsBytes.length, layoutAt]), S_OK);
        const shaderAt = h.box.place([0]);
        assert.equal(h.device(device, 'CreateVertexShader', [vsAt, vsBytes.length, shaderAt]),
            S_OK);
        const vs = h.box.memory.readU32(shaderAt);
        const psBytes = solidPixelShader([0, 0, 1, 1]);
        const psAt = h.box.placeBytes(psBytes);
        assert.equal(h.device(device, 'CreatePixelShader', [psAt, psBytes.length, shaderAt]),
            S_OK);
        const ps = h.box.memory.readU32(shaderAt);

        // A shader that is not one is refused, and the pointer cleared.
        const refused = h.box.place([0xdeadbeef]);
        assert.equal(h.device(device, 'CreateVertexShader', [psAt, psBytes.length, refused]),
            E_INVALIDARG);
        assert.equal(h.box.memory.readU32(refused), 0);

        h.device(device, 'IASetInputLayout', [h.box.memory.readU32(layoutAt)]);
        h.device(device, 'IASetVertexBuffers',
            [0, 1, h.box.place([vertexBuffer]), h.box.place([16]), h.box.place([0])]);
        h.device(device, 'IASetPrimitiveTopology', [D3D10_PRIMITIVE_TOPOLOGY.TRIANGLELIST]);
        h.device(device, 'VSSetShader', [vs]);
        h.device(device, 'PSSetShader', [ps]);
        h.device(device, 'RSSetViewports', [1, h.box.place([0, 0, 8, 8, ...floatBits([0, 1])])]);
        h.device(device, 'OMSetRenderTargets', [1, h.box.place([view]), 0]);
        h.device(device, 'Draw', [3, 0]);
        assert.equal(h.swapChain(swapChain, 'Present', [0, 0]), S_OK);
        await /** @type {any} */ (h.publisher.objectAt(device)).idle();

        assert.deepEqual(h.divergences, []);
        assert.deepEqual(h.gpu.of('draw').map((/** @type {any} */ call)=>call.args), [[3, 1, 0, 0]]);
        const written = h.gpu.of('writeBuffer').find((/** @type {any} */ call)=>
            call.buffer.descriptor.label.startsWith('d3d10:buffer#48'));
        assert.ok(written);
        assert.deepEqual([...new Uint32Array(written.bytes.buffer, written.bytes.byteOffset, 12)],
            vertices, 'the guest\'s vertices are what the queue got');

        // The stream reads back as the same pointer, at its stride.
        const streamAt = h.box.place([0]);
        const strideAt = h.box.place([0]);
        h.device(device, 'IAGetVertexBuffers', [0, 1, streamAt, strideAt, 0]);
        assert.equal(h.box.memory.readU32(streamAt), vertexBuffer);
        assert.equal(h.box.memory.readU32(strideAt), 16);
        const shaderBack = h.box.place([0]);
        h.device(device, 'PSGetShader', [shaderBack]);
        assert.equal(h.box.memory.readU32(shaderBack), ps);
    });

test('more viewports than the pipeline has slots for is a call ignored whole', ()=>{
    // After Wine's d3d10core test_clear_render_target_view's tail.
    const h = seamed();
    const { device } = h.createDeviceAndSwapChain();
    h.device(device, 'RSSetViewports', [1, h.box.place([0, 0, 8, 8, ...floatBits([0, 1])])]);
    const many = h.box.place(Array.from({ length: 17 },
        ()=>[1, 0, 8, 8, ...floatBits([0, 1])]).flat());
    h.device(device, 'RSSetViewports', [17, many]);
    const countAt = h.box.place([17]);
    const out = h.box.place(new Array(17 * 6).fill(0x55555555));
    h.device(device, 'RSGetViewports', [countAt, out]);
    assert.equal(h.box.memory.readU32(countAt), 1, 'the count comes back as the number bound');
    assert.equal(h.box.memory.readU32(out), 0, 'the viewport set before is the one there');
    assert.equal(h.box.memory.readU32(out + 8), 8);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(k=>h.box.memory.readU32(out + 24 + k * 4)),
        [0, 0, 0, 0, 0, 0], 'and a slot past it reads as empty');
});

test('a map hands the program guest memory and the unmap reads it back', async()=>{
    const h = seamed();
    const { device, swapChain } = h.createDeviceAndSwapChain();
    const desc = h.box.place([
        16, D3D10_USAGE.DYNAMIC, D3D10_BIND.CONSTANT_BUFFER, D3D10_CPU_ACCESS.WRITE, 0,
    ]);
    const bufferAt = h.box.place([0]);
    assert.equal(h.device(device, 'CreateBuffer', [desc, 0, bufferAt]), S_OK);
    const buffer = h.box.memory.readU32(bufferAt);

    const dataAt = h.box.place([0]);
    assert.equal(h.box.call(buffer, slot(ID3D10BUFFER_SLOTS, 'Map'),
        [D3D10_MAP.WRITE_DISCARD, 0, dataAt]), S_OK);
    const data = h.box.memory.readU32(dataAt);
    assert.notEqual(data, 0, 'an address the program can write through');
    h.box.memory.writeU32(data, 0x11223344);
    h.box.memory.writeU32(data + 12, 0x55667788);
    h.box.call(buffer, slot(ID3D10BUFFER_SLOTS, 'Unmap'), []);
    h.device(device, 'PSSetConstantBuffers', [0, 1, h.box.place([buffer])]);
    assert.equal(h.swapChain(swapChain, 'Present', [0, 0]), S_OK);
    await /** @type {any} */ (h.publisher.objectAt(device)).idle();

    // A read map is refused on a write-only dynamic buffer, with the pointer cleared.
    h.box.memory.writeU32(dataAt, 0xdeadbeef);
    assert.equal(h.box.call(buffer, slot(ID3D10BUFFER_SLOTS, 'Map'), [D3D10_MAP.READ, 0, dataAt]),
        E_INVALIDARG);

    // The description reads back at the header's offsets.
    const descOut = h.box.allocate(0x14);
    h.box.call(buffer, slot(ID3D10BUFFER_SLOTS, 'GetDesc'), [descOut]);
    assert.equal(h.box.memory.readU32(descOut), 16);
    assert.equal(h.box.memory.readU32(descOut + 4), D3D10_USAGE.DYNAMIC);
    assert.equal(h.box.memory.readU32(descOut + 8), D3D10_BIND.CONSTANT_BUFFER);
    assert.equal(h.box.memory.readU32(descOut + 12), D3D10_CPU_ACCESS.WRITE);

    const object = h.publisher.objectAt(buffer);
    /** @type {{ data?: Uint8Array | null }} */
    const held = {};
    assert.equal(object.Map(0, D3D10_MAP.WRITE_NO_OVERWRITE, 0, held), S_OK);
    const words = new Uint32Array(/** @type {Uint8Array} */ (held.data).buffer,
        /** @type {Uint8Array} */ (held.data).byteOffset, 4);
    assert.equal(words[0], 0x11223344, 'the first dword the program wrote');
    assert.equal(words[3], 0x55667788, 'and the last');
    object.Unmap(0);
});

test('DXGI: a factory enumerates its adapter and outputs, and parents lead back', ()=>{
    const h = seamed();
    const factoryAt = h.box.place([0]);
    assert.equal(h.dxgi.CreateDXGIFactory.handler([h.box.placeGuid(IID.IDXGIFactory), factoryAt])
        >>> 0, S_OK);
    const factory = h.box.memory.readU32(factoryAt);
    assert.notEqual(factory, 0);
    assert.equal(h.dxgi.CreateDXGIFactory.handler([h.box.placeGuid(IID.IDXGIFactory1), factoryAt])
        >>> 0, 0x80004002, 'the first version of DXGI, not the second');

    const adapterAt = h.box.place([0]);
    assert.equal(h.box.call(factory, slot(IDXGIFACTORY_SLOTS, 'EnumAdapters'), [0, adapterAt]),
        S_OK);
    const adapter = h.box.memory.readU32(adapterAt);
    assert.equal(h.box.call(factory, slot(IDXGIFACTORY_SLOTS, 'EnumAdapters'), [1, adapterAt]),
        0x887a0002, 'one adapter');
    assert.equal(h.box.memory.readU32(adapterAt), 0);

    const descAt = h.box.allocate(0x124);
    assert.equal(h.box.call(adapter, slot(IDXGIADAPTER_SLOTS, 'GetDesc'), [descAt]), S_OK);
    assert.equal(h.box.memory.readU32(descAt), 0x006f0042,
        'the description starts "Bo", as wide characters');
    assert.equal(h.box.memory.readU32(descAt + 0x110), 1 << 30, 'DedicatedVideoMemory');

    const outputAt = h.box.place([0]);
    assert.equal(h.box.call(adapter, slot(IDXGIADAPTER_SLOTS, 'EnumOutputs'), [0, outputAt]),
        S_OK);
    assert.notEqual(h.box.memory.readU32(outputAt), 0);

    const parentAt = h.box.place([0]);
    assert.equal(h.box.call(adapter, slot(IDXGIADAPTER_SLOTS, 'GetParent'),
        [h.box.placeGuid(IID.IDXGIFactory), parentAt]), S_OK);
    assert.equal(h.box.memory.readU32(parentAt), factory, 'the factory the adapter came from');

    // A device on that adapter, and the adapter through the device.
    const deviceAt = h.box.place([0]);
    assert.equal(h.d3d10.D3D10CreateDevice.handler([
        adapter, D3D10_DRIVER_TYPE.HARDWARE, 0, 0, D3D10_SDK_VERSION, deviceAt,
    ]) >>> 0, S_OK);
    const device = h.box.memory.readU32(deviceAt);
    const dxgiDeviceAt = h.box.place([0]);
    assert.equal(h.box.call(device, 0, [h.box.placeGuid(IID.IDXGIDevice), dxgiDeviceAt]), S_OK,
        'QueryInterface for the DXGI device');
    const dxgiDevice = h.box.memory.readU32(dxgiDeviceAt);
    const adapterBack = h.box.place([0]);
    assert.equal(h.box.call(dxgiDevice, 7, [adapterBack]), S_OK, 'IDXGIDevice::GetAdapter');
    assert.equal(h.box.memory.readU32(adapterBack), adapter);
});

test('a state description round-trips through guest memory, normalised', ()=>{
    const h = seamed();
    const { device } = h.createDeviceAndSwapChain();
    // A rasterizer description: solid, cull none, counter-clockwise front,
    // a depth bias and its clamp as a float.
    const desc = h.box.place([3, 1, 1, 0xfffffffe, ...floatBits([0.5, 2]), 1, 1, 0, 0]);
    const stateAt = h.box.place([0]);
    assert.equal(h.device(device, 'CreateRasterizerState', [desc, stateAt]), S_OK);
    const state = h.box.memory.readU32(stateAt);
    const out = h.box.allocate(0x28);
    h.box.call(state, 3 + 4, [out]);
    assert.deepEqual([0, 4, 8, 0xc, 0x18, 0x1c].map(at=>h.box.memory.readU32(out + at)),
        [3, 1, 1, 0xfffffffe, 1, 1]);
    assert.deepEqual([...new Float32Array(h.box.services.readMemory(out + 0x10, 8).buffer)],
        [0.5, 2]);
    // A second create with the same description is the same pointer.
    assert.equal(h.device(device, 'CreateRasterizerState', [desc, stateAt]), S_OK);
    assert.equal(h.box.memory.readU32(stateAt), state);
    h.device(device, 'RSSetState', [state]);
    const back = h.box.place([0]);
    h.device(device, 'RSGetState', [back]);
    assert.equal(h.box.memory.readU32(back), state);

    // A null description is refused and the pointer cleared.
    h.box.memory.writeU32(stateAt, 0xdeadbeef);
    assert.equal(h.device(device, 'CreateBlendState', [0, stateAt]), E_INVALIDARG);
    assert.equal(h.box.memory.readU32(stateAt), 0);
});

test('private data travels in both method orders, DXGI\'s and Direct3D\'s', ()=>{
    const h = seamed();
    const { device, swapChain } = h.createDeviceAndSwapChain();
    const guid = h.box.placeGuid('{12345678-1234-1234-1234-123456789ABC}');
    const bytes = h.box.placeBytes(Uint8Array.from([9, 8, 7]));
    assert.equal(h.device(device, 'SetPrivateData', [guid, 3, bytes]), S_OK);
    const sizeAt = h.box.place([16]);
    const dataAt = h.box.allocate(16);
    assert.equal(h.device(device, 'GetPrivateData', [guid, sizeAt, dataAt]), S_OK);
    assert.equal(h.box.memory.readU32(sizeAt), 3);
    assert.deepEqual([...h.box.services.readMemory(dataAt, 3)], [9, 8, 7]);

    // The swap chain's slot for the same call sits in DXGI's order: first, not third.
    assert.equal(h.swapChain(swapChain, 'SetPrivateData', [guid, 3, bytes]), S_OK);
    h.box.memory.writeU32(sizeAt, 1);
    assert.equal(h.swapChain(swapChain, 'GetPrivateData', [guid, sizeAt, dataAt]), 0x887a0003,
        'more data than there is room for');
    assert.equal(h.box.memory.readU32(sizeAt), 3);
    assert.equal(h.swapChain(swapChain, 'GetPrivateData', [guid, sizeAt, 0]), S_OK,
        'no room at all just asks the size');
});

test('a query answers through its vtable, and a predicate is published as one', ()=>{
    const h = seamed();
    const { device } = h.createDeviceAndSwapChain();
    const desc = h.box.place([D3D10_QUERY.EVENT, 0]);
    const queryAt = h.box.place([0]);
    assert.equal(h.device(device, 'CreateQuery', [desc, queryAt]), S_OK);
    const query = h.box.memory.readU32(queryAt);
    const call = (/** @type {number} */ target, /** @type {string} */ name,
        /** @type {number[]} */ args)=>h.box.call(target, slot(ID3D10QUERY_SLOTS, name), args);
    assert.equal(call(query, 'GetDataSize', []), 4);
    const dataAt = h.box.place([0xdeadbeef]);
    assert.equal(call(query, 'GetData', [dataAt, 4, 0]), DXGI_ERROR_INVALID_CALL);
    call(query, 'End', []);
    assert.equal(call(query, 'GetData', [dataAt, 4, 0]), S_OK);
    assert.equal(h.box.memory.readU32(dataAt), 1, 'TRUE, written where the program asked');

    const predicateDesc = h.box.place([D3D10_QUERY.OCCLUSION_PREDICATE, 0]);
    const predicateAt = h.box.place([0xdeadbeef]);
    assert.equal(h.device(device, 'CreatePredicate', [predicateDesc, predicateAt]), S_OK);
    const predicate = h.box.memory.readU32(predicateAt);
    assert.notEqual(predicate, 0);
    h.device(device, 'SetPredication', [predicate, 1]);
    const backAt = h.box.place([0]);
    const valueAt = h.box.place([0]);
    h.device(device, 'GetPredication', [backAt, valueAt]);
    assert.equal(h.box.memory.readU32(backAt), predicate, 'the same pointer back');
    assert.equal(h.box.memory.readU32(valueAt), 1);
    assert.equal(call(predicate, 'GetDataSize', []), 4);

    // The asynchronous base answers a query's QueryInterface; a predicate's
    // interface does not answer a plain query's.
    const asyncAt = h.box.place([0]);
    assert.equal(h.box.call(query, 0, [h.box.placeGuid(IID.ID3D10Asynchronous), asyncAt]), S_OK);
    assert.equal(h.box.call(query, 0, [h.box.placeGuid(IID.ID3D10Predicate), asyncAt]),
        0x80004002);
});

test('a block-compressed texture\'s data is read a row of blocks at a time', ()=>{
    const h = seamed();
    const { device } = h.createDeviceAndSwapChain();
    // An 8x8 BC1 texture: two rows of two eight-byte blocks, and staging so
    // the bytes can be mapped back.
    const blocks = Uint8Array.from({ length: 32 }, (_, at)=>at + 1);
    const desc = h.box.place([8, 8, 1, 1, DXGI_FORMAT.BC1_UNORM, 1, 0, D3D10_USAGE.STAGING, 0,
        D3D10_CPU_ACCESS.READ | D3D10_CPU_ACCESS.WRITE, 0]);
    const initial = h.box.place([h.box.placeBytes(blocks), 16, 0]);
    const textureAt = h.box.place([0]);
    assert.equal(h.device(device, 'CreateTexture2D', [desc, initial, textureAt]), S_OK);
    const texture = h.box.memory.readU32(textureAt);
    const mapped = h.box.place([0, 0]);
    assert.equal(h.box.call(texture, slot(ID3D10TEXTURE_SLOTS, 'Map'),
        [0, D3D10_MAP.READ, 0, mapped]), S_OK);
    assert.equal(h.box.memory.readU32(mapped + 4), 16, 'RowPitch: one row of blocks');
    assert.deepEqual([...h.box.services.readMemory(h.box.memory.readU32(mapped), 32)],
        [...blocks]);
    h.box.call(texture, slot(ID3D10TEXTURE_SLOTS, 'Unmap'), [0]);
});

test('a resource answers QueryInterface for every interface it derives from', ()=>{
    // After Wine's d3d10core test_create_texture2d (IDXGISurface only for a
    // single subresource) and test_private_data (IDXGISurface_GetPrivateData).
    const h = seamed();
    const { device } = h.createDeviceAndSwapChain();
    /** @param {number} object @param {string} iid */
    const query = (object, iid)=>{
        const out = h.box.place([0xdeadbeef]);
        const hr = h.box.call(object, 0, [h.box.placeGuid(iid), out]);
        return { hr, pointer: h.box.memory.readU32(out) };
    };
    /** @param {number} mipLevels */
    const texture = mipLevels=>{
        const desc = h.box.place([4, 4, mipLevels, 1, DXGI_FORMAT.R8G8B8A8_UNORM, 1, 0,
            D3D10_USAGE.STAGING, 0, D3D10_CPU_ACCESS.READ | D3D10_CPU_ACCESS.WRITE, 0]);
        const out = h.box.place([0]);
        assert.equal(h.device(device, 'CreateTexture2D', [desc, 0, out]), S_OK);
        return h.box.memory.readU32(out);
    };
    const single = texture(1);
    for (const iid of [IID.ID3D10Resource, IID.ID3D10DeviceChild, IID.IDXGIObject,
        IID.IDXGIDeviceSubObject, IID.IDXGIResource, IID.IDXGISurface])
    {
        const answer = query(single, iid);
        assert.equal(answer.hr, S_OK, `the texture is an ${iid}`);
        assert.notEqual(answer.pointer, 0);
    }
    const chain = texture(0);
    assert.deepEqual(query(chain, IID.IDXGISurface), { hr: 0x80004002, pointer: 0 },
        'a mip chain is not one surface');
    assert.equal(query(chain, IID.IDXGIResource).hr, S_OK);

    // Through the surface: its description, its device and parent, and a map.
    const surface = query(single, IID.IDXGISurface).pointer;
    const descAt = h.box.place([0, 0, 0, 0, 0]);
    assert.equal(h.box.call(surface, slot(IDXGISURFACE_SLOTS, 'GetDesc'), [descAt]), S_OK);
    assert.deepEqual([0, 4, 8, 12, 16].map(at=>h.box.memory.readU32(descAt + at)),
        [4, 4, DXGI_FORMAT.R8G8B8A8_UNORM, 1, 0]);
    const parentAt = h.box.place([0]);
    assert.equal(h.box.call(surface, slot(IDXGISURFACE_SLOTS, 'GetParent'),
        [h.box.placeGuid(IID.ID3D10Device), parentAt]), S_OK);
    assert.equal(h.box.memory.readU32(parentAt), device, 'the parent is the device');
    const deviceAt = h.box.place([0]);
    assert.equal(h.box.call(surface, slot(IDXGISURFACE_SLOTS, 'GetDevice'),
        [h.box.placeGuid(IID.ID3D10Device), deviceAt]), S_OK);
    assert.equal(h.box.memory.readU32(deviceAt), device);
    const rect = h.box.place([0, 0]);
    assert.equal(h.box.call(surface, slot(IDXGISURFACE_SLOTS, 'Map'), [rect, 2]), S_OK);
    assert.equal(h.box.memory.readU32(rect), 16, 'Pitch');
    h.box.memory.writeU32(h.box.memory.readU32(rect + 4), 0x44332211);
    assert.equal(h.box.call(surface, slot(IDXGISURFACE_SLOTS, 'Unmap'), []), S_OK);
    const mapped = h.box.place([0, 0]);
    assert.equal(h.box.call(single, slot(ID3D10TEXTURE_SLOTS, 'Map'),
        [0, D3D10_MAP.READ, 0, mapped]), S_OK);
    assert.equal(h.box.memory.readU32(h.box.memory.readU32(mapped)), 0x44332211,
        'what the surface wrote, the texture reads');
    h.box.call(single, slot(ID3D10TEXTURE_SLOTS, 'Unmap'), [0]);

    // A buffer is a DXGI resource and never a surface.
    const bufferDesc = h.box.place([16, D3D10_USAGE.DEFAULT, D3D10_BIND.VERTEX_BUFFER, 0, 0]);
    const bufferAt = h.box.place([0]);
    assert.equal(h.device(device, 'CreateBuffer', [bufferDesc, 0, bufferAt]), S_OK);
    const buffer = h.box.memory.readU32(bufferAt);
    assert.equal(query(buffer, IID.IDXGIResource).hr, S_OK);
    assert.equal(query(buffer, IID.ID3D10Resource).hr, S_OK);
    assert.equal(query(buffer, IID.IDXGISurface).hr, 0x80004002);

    // A view is an ID3D10View; its resource comes back as the pointer held.
    const bufferTextureAt = h.box.place([0]);
    const rtDesc = h.box.place([4, 4, 1, 1, DXGI_FORMAT.R8G8B8A8_UNORM, 1, 0,
        D3D10_USAGE.DEFAULT, D3D10_BIND.RENDER_TARGET, 0, 0]);
    assert.equal(h.device(device, 'CreateTexture2D', [rtDesc, 0, bufferTextureAt]), S_OK);
    const target = h.box.memory.readU32(bufferTextureAt);
    const viewAt = h.box.place([0]);
    assert.equal(h.device(device, 'CreateRenderTargetView', [target, 0, viewAt]), S_OK);
    const baseView = query(h.box.memory.readU32(viewAt), IID.ID3D10View).pointer;
    assert.notEqual(baseView, 0);
    const resourceAt = h.box.place([0]);
    h.box.call(baseView, slot(ID3D10VIEW_SLOTS, 'GetResource'), [resourceAt]);
    assert.equal(h.box.memory.readU32(resourceAt), target);
    assert.equal(query(h.box.memory.readU32(viewAt), IID.ID3D10DeviceChild).hr, S_OK);
});

test('a back buffer is a DXGI resource of the back buffer\'s usage', ()=>{
    // After Wine's dxgi test_swapchain_parameters.
    const h = seamed();
    const { swapChain } = h.createDeviceAndSwapChain();
    const out = h.box.place([0]);
    assert.equal(h.swapChain(swapChain, 'GetBuffer',
        [0, h.box.placeGuid(IID.IDXGIResource), out]), S_OK);
    const resource = h.box.memory.readU32(out);
    assert.notEqual(resource, 0);
    const usageAt = h.box.place([0]);
    assert.equal(h.box.call(resource, slot(IDXGIRESOURCE_SLOTS, 'GetUsage'), [usageAt]), S_OK);
    const usage = h.box.memory.readU32(usageAt);
    assert.equal(usage & (DXGI_USAGE.RENDER_TARGET_OUTPUT | DXGI_USAGE.BACK_BUFFER),
        DXGI_USAGE.RENDER_TARGET_OUTPUT | DXGI_USAGE.BACK_BUFFER);
    assert.equal(h.swapChain(swapChain, 'GetBuffer',
        [0, h.box.placeGuid(IID.IDXGISurface), out]), S_OK, 'and one surface');
    const handleAt = h.box.place([0xdeadbeef]);
    assert.equal(h.box.call(resource, slot(IDXGIRESOURCE_SLOTS, 'GetSharedHandle'), [handleAt]),
        S_OK);
    assert.equal(h.box.memory.readU32(handleAt), 0, 'nothing is shared');
});

test('the device answers as ID3D10Multithread and IDXGIDevice1', ()=>{
    // After Wine's d3d10core test_create_device and dxgi test_maximum_frame_latency.
    const h = seamed();
    const { device } = h.createDeviceAndSwapChain();
    /** @param {string} iid */
    const query = iid=>{
        const out = h.box.place([0]);
        assert.equal(h.box.call(device, 0, [h.box.placeGuid(iid), out]), S_OK, iid);
        return h.box.memory.readU32(out);
    };
    const multithread = query(IID.ID3D10Multithread);
    const mt = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        h.box.call(multithread, slot(ID3D10MULTITHREAD_SLOTS, name), args);
    assert.equal(mt('GetMultithreadProtected', []), 1, 'protected unless made single-threaded');
    assert.equal(mt('SetMultithreadProtected', [0]), 1, 'the state before');
    assert.equal(mt('GetMultithreadProtected', []), 0);
    mt('Enter', []);
    mt('Leave', []);

    const device1 = query(IID.IDXGIDevice1);
    const latency = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        h.box.call(device1, slot(IDXGIDEVICE1_SLOTS, name), args);
    const out = h.box.place([0]);
    assert.equal(latency('GetMaximumFrameLatency', [0]), DXGI_ERROR_INVALID_CALL);
    assert.equal(latency('GetMaximumFrameLatency', [out]), S_OK);
    assert.equal(h.box.memory.readU32(out), 3, 'three frames by default');
    assert.equal(latency('SetMaximumFrameLatency', [16]), S_OK);
    assert.equal(latency('SetMaximumFrameLatency', [17]), DXGI_ERROR_INVALID_CALL);
    latency('GetMaximumFrameLatency', [out]);
    assert.equal(h.box.memory.readU32(out), 16);
    assert.equal(latency('SetMaximumFrameLatency', [0]), S_OK);
    latency('GetMaximumFrameLatency', [out]);
    assert.equal(h.box.memory.readU32(out), 3);
    assert.notEqual(query(IID.IDXGIObject), 0);
});

test('an adapter is an IDXGIAdapter1 too, whose description has a word of flags more', ()=>{
    // After Wine's dxgi test_adapter_desc.
    const h = seamed();
    const factoryAt = h.box.place([0]);
    h.dxgi.CreateDXGIFactory.handler([h.box.placeGuid(IID.IDXGIFactory), factoryAt]);
    const adapterAt = h.box.place([0]);
    h.box.call(h.box.memory.readU32(factoryAt), slot(IDXGIFACTORY_SLOTS, 'EnumAdapters'),
        [0, adapterAt]);
    const adapter = h.box.memory.readU32(adapterAt);
    assert.equal(h.box.call(adapter, slot(IDXGIADAPTER_SLOTS, 'GetDesc'), [0]), E_INVALIDARG);
    const out = h.box.place([0]);
    assert.equal(h.box.call(adapter, 0, [h.box.placeGuid(IID.IDXGIAdapter1), out]), S_OK);
    const adapter1 = h.box.memory.readU32(out);
    const desc = h.box.allocate(0x128);
    h.box.memory.writeU32(desc + 0x124, 0xdeadbeef);
    assert.equal(h.box.call(adapter1, slot(IDXGIADAPTER1_SLOTS, 'GetDesc1'), [desc]), S_OK);
    assert.equal(h.box.memory.readU32(desc), 0x006f0042, 'the same description');
    assert.equal(h.box.memory.readU32(desc + 0x124), 0, 'Flags');
});

test('a staging copy of what the GPU drew is read back, and its map waits for it', async()=>{
    // After Wine's d3d10core get_texture_readback: CopyResource into a
    // staging texture, then Map(READ).
    const h = seamed();
    const { device } = h.createDeviceAndSwapChain();
    const targetDesc = h.box.place([4, 4, 1, 1, DXGI_FORMAT.R8G8B8A8_UNORM, 1, 0,
        D3D10_USAGE.DEFAULT, D3D10_BIND.RENDER_TARGET, 0, 0]);
    const targetAt = h.box.place([0]);
    assert.equal(h.device(device, 'CreateTexture2D', [targetDesc, 0, targetAt]), S_OK);
    const target = h.box.memory.readU32(targetAt);
    const viewAt = h.box.place([0]);
    assert.equal(h.device(device, 'CreateRenderTargetView', [target, 0, viewAt]), S_OK);
    h.device(device, 'ClearRenderTargetView',
        [h.box.memory.readU32(viewAt), h.box.place(floatBits([1, 0, 0, 1]))]);

    const stagingDesc = h.box.place([4, 4, 1, 1, DXGI_FORMAT.R8G8B8A8_UNORM, 1, 0,
        D3D10_USAGE.STAGING, 0, D3D10_CPU_ACCESS.READ, 0]);
    const stagingAt = h.box.place([0]);
    assert.equal(h.device(device, 'CreateTexture2D', [stagingDesc, 0, stagingAt]), S_OK);
    const staging = h.box.memory.readU32(stagingAt);
    h.device(device, 'CopyResource', [staging, target]);

    const mapped = h.box.place([0, 0]);
    const mapSlot = slot(ID3D10TEXTURE_SLOTS, 'Map');
    assert.equal(h.box.call(staging, mapSlot, [0, D3D10_MAP.READ, D3D10_MAP_FLAG_DO_NOT_WAIT,
        mapped]), 0x887a000a, 'DXGI_ERROR_WAS_STILL_DRAWING while the copy is on its way');
    assert.equal(await h.box.callParked(staging, mapSlot, [0, D3D10_MAP.READ, 0, mapped]), S_OK,
        'a map that may wait, waits');
    const bytes = h.box.services.readMemory(h.box.memory.readU32(mapped), 64);
    assert.deepEqual([...bytes.subarray(0, 4)], [255, 0, 0, 255], 'what the GPU cleared');
    assert.deepEqual([...bytes.subarray(60, 64)], [255, 0, 0, 255]);
    assert.equal(h.gpu.count('copyTextureToBuffer'), 1);
    assert.equal(h.presented.length, 0, 'nothing was shown to get there');
    h.box.call(staging, slot(ID3D10TEXTURE_SLOTS, 'Unmap'), [0]);
    assert.deepEqual(h.divergences, []);
});

test('an output lists its modes and finds the one nearest a request', ()=>{
    // After Wine's dxgi test_output and test_find_closest_matching_mode.
    const h = seamed();
    const { swapChain } = h.createDeviceAndSwapChain();
    const outputAt = h.box.place([0]);
    assert.equal(h.swapChain(swapChain, 'GetContainingOutput', [outputAt]), S_OK,
        'the window is on the adapter\'s output');
    const output = h.box.memory.readU32(outputAt);
    assert.notEqual(output, 0);
    const call = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        h.box.call(output, slot(IDXGIOUTPUT_SLOTS, name), args);

    const countAt = h.box.place([0]);
    assert.equal(call('GetDisplayModeList', [DXGI_FORMAT.R8G8B8A8_UNORM, 0, 0, 0]),
        DXGI_ERROR_INVALID_CALL, 'no count to write to');
    assert.equal(call('GetDisplayModeList', [DXGI_FORMAT.R8G8B8A8_UNORM, 0, countAt, 0]), S_OK);
    const count = h.box.memory.readU32(countAt);
    assert.ok(count > 3, `${count} modes`);
    assert.equal(call('GetDisplayModeList', [0, 0, countAt, 0]), S_OK);
    assert.equal(h.box.memory.readU32(countAt), 0, 'none in no format');

    const list = h.box.allocate(count * 28);
    h.box.memory.writeU32(countAt, 1);
    assert.equal(call('GetDisplayModeList', [DXGI_FORMAT.R8G8B8A8_UNORM, 2, countAt, list]),
        0x887a0003, 'DXGI_ERROR_MORE_DATA');
    assert.equal(h.box.memory.readU32(countAt), 1, 'the count left as it was given');
    h.box.memory.writeU32(countAt, count + 5);
    assert.equal(call('GetDisplayModeList', [DXGI_FORMAT.R8G8B8A8_UNORM, 2, countAt, list]),
        S_OK);
    assert.equal(h.box.memory.readU32(countAt), count);
    /** @param {number} index */
    const mode = index=>[0, 4, 8, 12, 16, 20, 24]
        .map(at=>h.box.memory.readU32(list + index * 28 + at));
    assert.deepEqual(mode(0), [640, 480, 60, 1, DXGI_FORMAT.R8G8B8A8_UNORM, 1, 0],
        'smallest first, progressive, at the one rate');
    for (let index = 1; index < count; index++)
    {
        const [width, height] = mode(index);
        const [lastWidth, lastHeight] = mode(index - 1);
        assert.ok(width > lastWidth || (width === lastWidth && height > lastHeight),
            `mode ${index} is sorted`);
    }

    const wanted = h.box.allocate(28);
    const closest = h.box.allocate(28);
    /** @param {number[]} fields */
    const find = fields=>{
        fields.forEach((value, index)=>h.box.memory.writeU32(wanted + index * 4, value));
        return call('FindClosestMatchingMode', [wanted, closest, 0]);
    };
    assert.equal(find([0, 0, 0, 0, 0, 0, 0]), DXGI_ERROR_INVALID_CALL,
        'no format and no device to take one from');
    assert.equal(find([800, 0, 0, 0, DXGI_FORMAT.R8G8B8A8_UNORM, 0, 0]),
        DXGI_ERROR_INVALID_CALL, 'half a size');
    assert.equal(find([801, 599, 0, 0, DXGI_FORMAT.R8G8B8A8_UNORM, 0, 0]), S_OK);
    assert.deepEqual([0, 4, 8, 12, 16].map(at=>h.box.memory.readU32(closest + at)),
        [800, 600, 60, 1, DXGI_FORMAT.R8G8B8A8_UNORM], 'the nearest size');
    assert.equal(find([10, 10, 0, 0, DXGI_FORMAT.R8G8B8A8_UNORM, 0, 0]), S_OK);
    assert.deepEqual([0, 4].map(at=>h.box.memory.readU32(closest + at)), [640, 480]);

    // What only a fullscreen swap chain owns is refused, as it is while there is none.
    assert.equal(call('GetGammaControlCapabilities', [h.box.allocate(4096)]),
        DXGI_ERROR_INVALID_CALL);
    assert.equal(call('GetFrameStatistics', [h.box.allocate(32)]), DXGI_ERROR_INVALID_CALL);
});

test('a DXGI device makes surfaces, and finds every resource resident', ()=>{
    // After Wine's dxgi test_create_surface and test_parents.
    const h = seamed();
    const { device } = h.createDeviceAndSwapChain();
    const dxgiAt = h.box.place([0]);
    assert.equal(h.box.call(device, 0, [h.box.placeGuid(IID.IDXGIDevice), dxgiAt]), S_OK);
    const dxgi = h.box.memory.readU32(dxgiAt);
    const desc = h.box.place([64, 32, DXGI_FORMAT.R8G8B8A8_UNORM, 1, 0]);
    const surfacesAt = h.box.place([0, 0]);
    assert.equal(h.box.call(dxgi, slot(IDXGIDEVICE_SLOTS, 'CreateSurface'),
        [desc, 2, DXGI_USAGE.RENDER_TARGET_OUTPUT, 0, surfacesAt]), S_OK);
    const surface = h.box.memory.readU32(surfacesAt);
    assert.notEqual(surface, 0);
    assert.notEqual(h.box.memory.readU32(surfacesAt + 4), surface, 'two surfaces');
    const parentAt = h.box.place([0]);
    assert.equal(h.box.call(surface, slot(IDXGISURFACE_SLOTS, 'GetParent'),
        [h.box.placeGuid(IID.IDXGIDevice), parentAt]), S_OK);
    assert.equal(h.box.memory.readU32(parentAt), dxgi, 'the device it came from');
    const surfaceDesc = h.box.place([0, 0, 0, 0, 0]);
    h.box.call(surface, slot(IDXGISURFACE_SLOTS, 'GetDesc'), [surfaceDesc]);
    assert.deepEqual([0, 4, 8].map(at=>h.box.memory.readU32(surfaceDesc + at)),
        [64, 32, DXGI_FORMAT.R8G8B8A8_UNORM]);

    const status = h.box.place([0, 0]);
    assert.equal(h.box.call(dxgi, slot(IDXGIDEVICE_SLOTS, 'QueryResourceResidency'),
        [surfacesAt, status, 2]), S_OK);
    assert.deepEqual([h.box.memory.readU32(status), h.box.memory.readU32(status + 4)], [1, 1],
        'DXGI_RESIDENCY_FULLY_RESIDENT');
});

test('d3d10.dll makes blobs, cuts signatures out of a shader and reflects it', ()=>{
    // After Wine's d3dcompiler test_create_blob, test_get_blob_part and
    // test_reflection_desc_vs, and d3d10_1 test_shader_profiles.
    const h = seamed();
    const D3DERR_INVALIDCALL = 0x8876086c;
    const E_FAIL = 0x80004005;
    const blobCall = (/** @type {number} */ blob, /** @type {string} */ name)=>
        h.box.call(blob, slot(ID3D10BLOB_SLOTS, name));

    const blobAt = h.box.place([0xdeadbeef]);
    assert.equal(h.d3d10.D3D10CreateBlob.handler([1, 0]) >>> 0, D3DERR_INVALIDCALL);
    assert.equal(h.d3d10.D3D10CreateBlob.handler([0, 0]) >>> 0, D3DERR_INVALIDCALL);
    assert.equal(h.d3d10.D3D10CreateBlob.handler([6, blobAt]) >>> 0, S_OK);
    const blob = h.box.memory.readU32(blobAt);
    assert.equal(blobCall(blob, 'GetBufferSize'), 6);
    const pointer = blobCall(blob, 'GetBufferPointer');
    assert.notEqual(pointer, 0);
    assert.deepEqual([...h.box.services.readMemory(pointer, 6)], [0, 0, 0, 0, 0, 0]);
    assert.equal(h.box.call(blob, 2), 0, 'the last release');
    assert.equal(h.d3d10.D3D10CreateBlob.handler([0, blobAt]) >>> 0, S_OK, 'an empty blob');

    const shader = passThroughVertexShader();
    const shaderAt = h.box.placeBytes(shader);
    const signatureAt = h.box.place([0xdeadbeef]);
    assert.equal(h.d3d10.D3D10GetInputSignatureBlob.handler([0, shader.length, signatureAt])
        >>> 0, D3DERR_INVALIDCALL);
    assert.equal(h.d3d10.D3D10GetInputSignatureBlob.handler([shaderAt, shader.length, 0])
        >>> 0, D3DERR_INVALIDCALL);
    assert.equal(h.box.memory.readU32(signatureAt), 0xdeadbeef, 'left as it was');
    assert.equal(h.d3d10.D3D10GetInputSignatureBlob.handler([shaderAt, shader.length,
        signatureAt]) >>> 0, S_OK);
    const signature = h.box.memory.readU32(signatureAt);
    const signatureBytes = h.box.services.readMemory(blobCall(signature, 'GetBufferPointer'),
        blobCall(signature, 'GetBufferSize'));
    const word = (/** @type {Uint8Array} */ bytes, /** @type {number} */ index)=>
        new DataView(bytes.buffer, bytes.byteOffset).getUint32(index * 4, true);
    assert.equal(word(signatureBytes, 0), 0x43425844, 'DXBC');
    assert.equal(word(signatureBytes, 9), 0x4e475349, 'ISGN at dword 9');
    const both = h.box.place([0]);
    assert.equal(h.d3d10.D3D10GetInputAndOutputSignatureBlob.handler([shaderAt, shader.length,
        both]) >>> 0, S_OK);
    assert.equal(h.d3d10.D3D10GetShaderDebugInfo.handler([shaderAt, shader.length, both])
        >>> 0, E_FAIL, 'no debug information was compiled in');

    // Every name the reflection hands out is a string in guest memory.
    const reflectionAt = h.box.place([0xdeadbeef]);
    assert.equal(h.d3d10.D3D10ReflectShader.handler([h.box.place([1, 2, 3]), 12, reflectionAt])
        >>> 0, E_FAIL, 'not a container');
    assert.equal(h.box.memory.readU32(reflectionAt), 0);
    assert.equal(h.d3d10.D3D10ReflectShader.handler([shaderAt, shader.length, reflectionAt])
        >>> 0, S_OK);
    const reflection = h.box.memory.readU32(reflectionAt);
    const reflect = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        h.box.call(reflection, slot(ID3D10SHADERREFLECTION_SLOTS, name), args);
    assert.equal(reflect('GetDesc', [0]), E_FAIL);
    const desc = h.box.allocate(28 * 4);
    assert.equal(reflect('GetDesc', [desc]), S_OK);
    assert.equal(h.box.memory.readU32(desc), 0x10040, 'Version');
    assert.equal(h.box.memory.readU32(desc + 4), 0, 'no creator was recorded');
    assert.deepEqual([20, 24].map(at=>h.box.memory.readU32(desc + at)), [1, 1],
        'InputParameters and OutputParameters');
    const parameter = h.box.allocate(24);
    assert.equal(reflect('GetOutputParameterDesc', [0, parameter]), S_OK);
    const name = h.box.memory.readU32(parameter);
    assert.equal(String.fromCharCode(...h.box.services.readMemory(name, 11)), 'SV_POSITION');
    assert.deepEqual([4, 8, 12, 16].map(at=>h.box.memory.readU32(parameter + at)),
        [0, 0, 1, 3], 'index, register, D3D10_NAME_POSITION, float');
    assert.deepEqual([...h.box.services.readMemory(parameter + 20, 2)], [0xf, 0]);
    assert.equal(reflect('GetInputParameterDesc', [1, parameter]), E_INVALIDARG);
    assert.equal(reflect('GetResourceBindingDesc', [0, parameter]), E_INVALIDARG);
    assert.notEqual(reflect('GetConstantBufferByIndex', [0]), 0,
        'a program with no constant buffer is answered the invalid one, not null');
    const queried = h.box.place([0]);
    assert.equal(h.box.call(reflection, 0,
        [h.box.placeGuid(IID.ID3D10ShaderReflection), queried]), S_OK);
    assert.equal(h.box.call(reflection, 2), 1);
    assert.equal(h.box.call(reflection, 2), 0);

    /** @type {Record<string, any>} */
    const entries = h.d3d10;
    const profile = (/** @type {string} */ entry)=>{
        const at = entries[entry].handler([0]) >>> 0;
        return String.fromCharCode(...h.box.services.readMemory(at, 6));
    };
    assert.equal(profile('D3D10GetVertexShaderProfile'), 'vs_4_0');
    assert.equal(profile('D3D10GetPixelShaderProfile'), 'ps_4_0');
    assert.equal(profile('D3D10GetGeometryShaderProfile'), 'gs_4_0');
    assert.equal(entries.D3D10GetVertexShaderProfile.handler([0]),
        entries.D3D10GetVertexShaderProfile.handler([0]), 'one string, kept');
});

test('a reflection\'s constant buffers, variables and types are tables without IUnknown', ()=>{
    // Wine's d3dcompiler test_reflection_constant_buffer, for its ps_4_0
    // program: an invalid object of each kind rather than null, one pointer
    // per object however it is looked up, and descriptions that write their
    // own fields and nothing past them.
    const h = seamed();
    const E_FAIL = 0x80004005;
    const shader = constantBufferShader();
    const shaderAt = h.box.placeBytes(shader);
    const reflectionAt = h.box.place([0]);
    assert.equal(h.d3d10.D3D10ReflectShader.handler([shaderAt, shader.length, reflectionAt])
        >>> 0, S_OK);
    const reflection = h.box.memory.readU32(reflectionAt);
    const reflect = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        h.box.call(reflection, slot(ID3D10SHADERREFLECTION_SLOTS, name), args);
    /** A table whose first slot is its own first method. @param {[string, number][]} slots */
    const on = slots=>(/** @type {number} */ pointer, /** @type {string} */ name,
        /** @type {number[]} */ args = [])=>
        h.box.call(pointer, slots.findIndex(([entry])=>entry === name), args);
    const buffer = on(ID3D10SHADERREFLECTIONCONSTANTBUFFER_SLOTS);
    const variable = on(ID3D10SHADERREFLECTIONVARIABLE_SLOTS);
    const type = on(ID3D10SHADERREFLECTIONTYPE_SLOTS);
    const text = (/** @type {number} */ at)=>{
        const bytes = h.box.services.readMemory(at, 64);
        return String.fromCharCode(...bytes.subarray(0, bytes.indexOf(0)));
    };
    /** @param {number} at @param {number} count */
    const dwords = (at, count)=>Array.from({ length: count },
        (_, index)=>h.box.memory.readU32(at + index * 4));
    const named = (/** @type {string} */ name)=>h.box.placeString(name);

    const invalid = reflect('GetConstantBufferByIndex', [0xffffffff]);
    assert.notEqual(invalid, 0);
    assert.equal(reflect('GetConstantBufferByName', [named('invalid')]), invalid);
    assert.equal(reflect('GetConstantBufferByName', [0]), invalid);
    const c1 = reflect('GetConstantBufferByIndex', [1]);
    assert.notEqual(c1, invalid);
    assert.equal(reflect('GetConstantBufferByName', [named('c1')]), c1,
        'the pointer the program already holds');

    const desc = h.box.place([1, 1, 1, 1, 1, 0xfeedface, 0xfeedface, 0xfeedface]);
    assert.equal(buffer(invalid, 'GetDesc', [desc]), E_FAIL);
    assert.equal(buffer(c1, 'GetDesc', [0]), E_FAIL);
    assert.equal(buffer(c1, 'GetDesc', [desc]), S_OK);
    assert.equal(text(h.box.memory.readU32(desc)), 'c1');
    assert.deepEqual(dwords(desc + 4, 5), [0, 4, 64, 0, 0xfeedface],
        'D3D10_CT_CBUFFER, four variables, 64 bytes, no flags, and nothing past them');

    const t = buffer(c1, 'GetVariableByName', [named('t')]);
    assert.equal(buffer(c1, 'GetVariableByIndex', [3]), t);
    const invalidVariable = buffer(c1, 'GetVariableByName', [0]);
    assert.notEqual(invalidVariable, 0);
    assert.notEqual(invalidVariable, t);
    assert.equal(buffer(invalid, 'GetVariableByIndex', [0]), invalidVariable);
    assert.equal(variable(invalidVariable, 'GetDesc', [desc]), E_FAIL);
    assert.equal(variable(t, 'GetDesc', [desc]), S_OK);
    assert.equal(text(h.box.memory.readU32(desc)), 't');
    assert.deepEqual(dwords(desc + 4, 5), [48, 8, 2, 0, 0xfeedface],
        'offset, size, D3D10_SVF_USED, no default value');

    const structure = variable(t, 'GetType');
    assert.equal(variable(t, 'GetType'), structure);
    assert.equal(type(structure, 'GetDesc', [desc]), S_OK);
    assert.deepEqual(dwords(desc, 8), [5, 0, 1, 2, 0, 2, 0, 0xfeedface],
        'D3D10_SVC_STRUCT, D3D10_SVT_VOID, one row of two, two members, at zero');
    const second = type(structure, 'GetMemberTypeByIndex', [1]);
    assert.equal(type(structure, 'GetMemberTypeByName', [named('b')]), second);
    assert.equal(text(type(structure, 'GetMemberTypeName', [1])), 'b');
    assert.equal(type(structure, 'GetMemberTypeName', [2]), 0);
    assert.equal(type(second, 'GetDesc', [desc]), S_OK);
    assert.equal(h.box.memory.readU32(desc + 24), 4, 'where it sits in its structure');

    const invalidType = variable(invalidVariable, 'GetType');
    assert.notEqual(invalidType, 0);
    assert.equal(type(structure, 'GetMemberTypeByIndex', [0xffffffff]), invalidType);
    assert.equal(type(structure, 'GetMemberTypeByName', [0]), invalidType);
    assert.equal(type(invalidType, 'GetDesc', [desc]), E_FAIL);
    assert.equal(text(type(invalidType, 'GetMemberTypeName', [0])), '$Invalid');
    assert.equal(h.box.argBytesOf(t, 1), 4, 'GetType takes the interface alone');

    // They go with the reflection's last Release, as the runtime frees them
    // with it; the invalid objects belong to no reflection and stay.
    const E_POINTER = 0x80004003;
    assert.equal(h.box.call(reflection, 2), 0, 'the last release');
    for (const [call, pointer] of /** @type {[any, number][]} */ ([[buffer, c1],
        [variable, t], [type, structure], [type, second]]))
    {
        assert.equal(call(pointer, 'GetDesc', [desc]), E_POINTER);
    }
    assert.equal(buffer(invalid, 'GetDesc', [desc]), E_FAIL, 'still answering');
    assert.equal(variable(invalidVariable, 'GetType'), invalidType);
});

test('a compile is refused as a failed compile, with the reason in the error blob', ()=>{
    const h = seamed();
    const E_FAIL = 0x80004005;
    const outs = h.box.place([0xdeadbeef, 0xdeadbeef]);
    const args = [h.box.placeString('float4 main() : SV_Target { return 0; }'), 38, 0, 0, 0,
        h.box.placeString('main'), h.box.placeString('ps_4_0'), 0, outs, outs + 4];
    assert.equal(h.d3d10.D3D10CompileShader.argBytes, 40);
    assert.equal(h.d3d10.D3D10CompileShader.handler(args) >>> 0, E_FAIL);
    assert.equal(h.box.memory.readU32(outs), 0, 'no shader');
    const errors = h.box.memory.readU32(outs + 4);
    assert.notEqual(errors, 0);
    const text = h.box.services.readMemory(h.box.call(errors, slot(ID3D10BLOB_SLOTS,
        'GetBufferPointer')), h.box.call(errors, slot(ID3D10BLOB_SLOTS, 'GetBufferSize')));
    assert.match(String.fromCharCode(...text), /no HLSL compiler/);
    assert.equal(h.d3d10.D3D10CompileEffectFromMemory.argBytes, 36);
    assert.equal(h.d3d10.D3D10CompileEffectFromMemory.handler([0, 0, 0, 0, 0, 0, 0, outs, 0])
        >>> 0, E_FAIL);
    assert.equal(h.d3d10.D3D10DisassembleShader.argBytes, 20);
    assert.equal(h.d3d10.D3D10DisassembleShader.handler([0, 0, 0, 0, outs]) >>> 0, E_NOTIMPL);
    assert.ok(h.divergences.some(line=>line.includes('D3D10CompileShader')));

    // An effect without a device is D3DERR_INVALIDCALL, with the out pointer
    // cleared; a pool is refused, as its child would be.
    const effectAt = h.box.place([0xdeadbeef]);
    assert.equal(h.d3d10.D3D10CreateEffectFromMemory.argBytes, 24);
    assert.equal(h.d3d10.D3D10CreateEffectFromMemory.handler([0, 0, 0, 0, 0, effectAt]) >>> 0,
        0x8876086c);
    assert.equal(h.box.memory.readU32(effectAt), 0);
    h.box.memory.writeU32(effectAt, 0xdeadbeef);
    assert.equal(h.d3d10.D3D10CreateEffectPoolFromMemory.argBytes, 20);
    assert.equal(h.d3d10.D3D10CreateEffectPoolFromMemory.handler([0, 0, 0, 0, effectAt])
        >>> 0, E_NOTIMPL);
    assert.equal(h.box.memory.readU32(effectAt), 0);
    assert.ok(h.divergences.some(line=>line.includes('effect pools')));
    assert.equal(h.d3d10.D3D10DisassembleEffect.argBytes, 12);
    assert.equal(h.d3d10.D3D10PreprocessShader.argBytes, 28);
    /** @type {Record<string, any>} */
    const entries = h.d3d10;
    /** @type {[string, number][]} */
    const arities = [['D3D10CreateBlob', 8], ['D3D10ReflectShader', 12],
        ['D3D10GetInputSignatureBlob', 12], ['D3D10GetOutputSignatureBlob', 12],
        ['D3D10GetInputAndOutputSignatureBlob', 12], ['D3D10GetShaderDebugInfo', 12],
        ['D3D10GetVertexShaderProfile', 4], ['D3D10GetPixelShaderProfile', 4],
        ['D3D10GetGeometryShaderProfile', 4]];
    for (const [entry, bytes] of arities)
    {
        assert.equal(entries[entry].argBytes, bytes, entry);
    }
});

test('DXGI 1.1: the second factory entry point answers as IDXGIFactory1', ()=>{
    // After Wine's dxgi test_create_factory.
    const h = seamed();
    const factoryAt = h.box.place([0xdeadbeef]);
    assert.equal(h.dxgi.CreateDXGIFactory1.handler([h.box.placeGuid(IID.IDXGIDevice),
        factoryAt]) >>> 0, 0x80004002);
    assert.equal(h.box.memory.readU32(factoryAt), 0);
    assert.equal(h.dxgi.CreateDXGIFactory1.handler([h.box.placeGuid(IID.IDXGIFactory1),
        factoryAt]) >>> 0, S_OK);
    const factory = h.box.memory.readU32(factoryAt);
    assert.equal(h.box.call(factory, slot(IDXGIFACTORY1_SLOTS, 'IsCurrent')), 1);
    const adapterAt = h.box.place([0]);
    assert.equal(h.box.call(factory, slot(IDXGIFACTORY1_SLOTS, 'EnumAdapters1'),
        [0, adapterAt]), S_OK);
    const adapter = h.box.memory.readU32(adapterAt);
    const descAt = h.box.allocate(0x128);
    assert.equal(h.box.call(adapter, slot(IDXGIADAPTER1_SLOTS, 'GetDesc1'), [descAt]), S_OK,
        'an IDXGIAdapter1');
    assert.equal(h.box.call(factory, slot(IDXGIFACTORY1_SLOTS, 'EnumAdapters1'),
        [1, adapterAt]), 0x887a0002, 'DXGI_ERROR_NOT_FOUND');

    const firstAt = h.box.place([0]);
    assert.equal(h.dxgi.CreateDXGIFactory.handler([h.box.placeGuid(IID.IDXGIFactory), firstAt])
        >>> 0, S_OK);
    const queried = h.box.place([0]);
    assert.equal(h.box.call(h.box.memory.readU32(firstAt), 0,
        [h.box.placeGuid(IID.IDXGIFactory1), queried]), 0x80004002,
    'a first-version factory is not the second');
});

test('d3d10_1.dll makes an ID3D10Device1 at 10.0, and forwards the rest to d3d10.dll', ()=>{
    // After Wine's d3d10_1 test_create_device and test_create_blend_state.
    const h = seamed();
    const library = /** @type {Record<string, any>} */ (h.seam.libraries['D3D10_1.dll']);
    assert.equal(library.D3D10CreateDevice1.argBytes, 28);
    assert.equal(library.D3D10CreateDeviceAndSwapChain1.argBytes, 36);
    assert.equal(library.D3D10CreateDevice, undefined, 'its own creates, not 10.0\'s');
    assert.equal(library.D3D10CreateBlob, h.d3d10.D3D10CreateBlob, 'forwarded');
    assert.equal(library.D3D10CreateStateBlock, h.d3d10.D3D10CreateStateBlock);

    const deviceAt = h.box.place([0xdeadbeef]);
    assert.equal(library.D3D10CreateDevice1.handler([0, D3D10_DRIVER_TYPE.HARDWARE, 0, 0,
        0xa100, 0x20, deviceAt]) >>> 0, 0x887a0004, 'DXGI_ERROR_UNSUPPORTED for 10.1');
    assert.equal(h.box.memory.readU32(deviceAt), 0);
    assert.equal(library.D3D10CreateDevice1.handler([0, D3D10_DRIVER_TYPE.HARDWARE, 0, 0,
        0xa000, 0x20, 0]) >>> 0, E_INVALIDARG, 'no device pointer');
    assert.equal(library.D3D10CreateDevice1.handler([0, D3D10_DRIVER_TYPE.HARDWARE, 0, 0,
        0xa000, 0x20, deviceAt]) >>> 0, S_OK);
    const device = h.box.memory.readU32(deviceAt);
    const call = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        h.box.call(device, slot(ID3D10DEVICE1_SLOTS, name), args);
    assert.equal(call('GetFeatureLevel', []), 0xa000);
    assert.equal(h.box.argBytesOf(device, slot(ID3D10DEVICE1_SLOTS, 'CreateBlendState1')), 12);

    // The adapter says so too, as dxgi test_check_interface_support wants of
    // an adapter whose devices answer as ID3D10Device1.
    const dxgiAt = h.box.place([0]);
    assert.equal(h.box.call(device, 0, [h.box.placeGuid(IID.IDXGIDevice), dxgiAt]), S_OK);
    const adapterAt = h.box.place([0]);
    assert.equal(h.box.call(h.box.memory.readU32(dxgiAt), slot(IDXGIDEVICE_SLOTS, 'GetAdapter'),
        [adapterAt]), S_OK);
    const adapter = h.box.memory.readU32(adapterAt);
    // test_check_interface_support (dxgi.c:1270-1304): the DXGI device and
    // both Direct3D 10 devices, with a driver version; anything else is
    // unsupported and the version is left alone.
    /** @param {string} iid */
    const supports = iid=>{
        const version = h.box.place([0xdeadbeef, 0xdeadbeef]);
        const hr = h.box.call(adapter, slot(IDXGIADAPTER_SLOTS, 'CheckInterfaceSupport'),
            [h.box.placeGuid(iid), version]);
        return [hr, h.box.memory.readU32(version), h.box.memory.readU32(version + 4)];
    };
    for (const iid of [IID.IDXGIDevice, IID.ID3D10Device, IID.ID3D10Device1])
    {
        assert.deepEqual(supports(iid), [S_OK, 0, 0x00010000], `${iid}: driver 1.0.0.0`);
        assert.equal(h.box.call(adapter, slot(IDXGIADAPTER_SLOTS, 'CheckInterfaceSupport'),
            [h.box.placeGuid(iid), 0]), S_OK, 'with no version asked');
    }
    const ID3D11Device = '{DB6F6DDB-AC77-4E88-8253-819DF9BBF140}';
    assert.deepEqual(supports(ID3D11Device), [DXGI_ERROR_UNSUPPORTED, 0xdeadbeef, 0xdeadbeef]);
    assert.deepEqual(supports(IID.IDXGIFactory), [DXGI_ERROR_UNSUPPORTED, 0xdeadbeef,
        0xdeadbeef]);

    // D3D10_BLEND_DESC1: two words, then eight targets of eight words.
    const desc = h.box.allocate(0x108);
    h.box.memory.writeU32(desc + 4, 1);
    for (let index = 0; index < 8; index++)
    {
        const at = desc + 8 + index * 32;
        [index % 2, 2, 1, 1, 2, 1, 1].forEach((value, field)=>
            h.box.memory.writeU32(at + field * 4, value));
        h.box.memory.writeU32(at + 28, index === 1 ? 1 : 15);
    }
    const stateAt = h.box.place([0]);
    assert.equal(call('CreateBlendState1', [desc, stateAt]), S_OK);
    const state = h.box.memory.readU32(stateAt);
    const back = h.box.allocate(0x108);
    h.box.call(state, slot(ID3D10BLENDSTATE1_SLOTS, 'GetDesc1'), [back]);
    assert.deepEqual([...h.box.services.readMemory(back, 0x108)],
        [...h.box.services.readMemory(desc, 0x108)], 'the description as it was given');
    const old = h.box.allocate(0x44);
    const asOld = h.box.place([0]);
    assert.equal(h.box.call(state, 0, [h.box.placeGuid(IID.ID3D10BlendState), asOld]), S_OK);
    h.box.call(h.box.memory.readU32(asOld), slot(ID3D10STATE_SLOTS, 'GetDesc'), [old]);
    assert.deepEqual([4, 8, 12].map(at=>h.box.memory.readU32(old + at)), [0, 1, 0],
        'the older reading: each target\'s enable');

    const textureDesc = h.box.place([4, 4, 1, 1, DXGI_FORMAT.R8G8B8A8_UNORM, 1, 0,
        D3D10_USAGE.DEFAULT, D3D10_BIND.SHADER_RESOURCE, 0, 0]);
    const textureAt = h.box.place([0]);
    assert.equal(call('CreateTexture2D', [textureDesc, 0, textureAt]), S_OK);
    const viewAt = h.box.place([0]);
    assert.equal(call('CreateShaderResourceView1', [h.box.memory.readU32(textureAt), 0, viewAt]),
        S_OK);
    const viewDesc = h.box.allocate(24);
    h.box.call(h.box.memory.readU32(viewAt), slot(ID3D10SHADERRESOURCEVIEW1_SLOTS, 'GetDesc1'),
        [viewDesc]);
    assert.deepEqual([0, 4, 8, 12].map(at=>h.box.memory.readU32(viewDesc + at)),
        [DXGI_FORMAT.R8G8B8A8_UNORM, 4, 0, 1]);

    const chainAt = h.box.place([0xdeadbeef]);
    const swapDesc = h.box.allocate(DXGI_SWAP_CHAIN_DESC.SIZE);
    writeSwapChainDesc(h.box.services, swapDesc, {
        bufferDesc: { width: 8, height: 8, refreshNumerator: 60, refreshDenominator: 1,
            format: DXGI_FORMAT.R8G8B8A8_UNORM, scanlineOrdering: 0, scaling: 0 },
        sampleDesc: { count: 1, quality: 0 }, bufferUsage: DXGI_USAGE.RENDER_TARGET_OUTPUT,
        bufferCount: 1, outputWindow: 0x1234, windowed: true,
        swapEffect: DXGI_SWAP_EFFECT.DISCARD, flags: 0,
    });
    assert.equal(library.D3D10CreateDeviceAndSwapChain1.handler([0, D3D10_DRIVER_TYPE.HARDWARE,
        0, 0, 0xa000, 0x20, swapDesc, chainAt, 0]) >>> 0, E_INVALIDARG);
    assert.equal(h.box.memory.readU32(chainAt), 0, 'the swap chain pointer cleared');
    assert.equal(library.D3D10CreateDeviceAndSwapChain1.handler([0, D3D10_DRIVER_TYPE.HARDWARE,
        0, 0, 0xa000, 0x20, swapDesc, chainAt, deviceAt]) >>> 0, S_OK);
    assert.notEqual(h.box.memory.readU32(chainAt), 0);
    assert.notEqual(h.box.memory.readU32(deviceAt), 0);
});

test('a state block is made from a mask in guest memory and captures through its vtable', ()=>{
    // After Wine's d3d10 test_stateblock.
    const h = seamed();
    const { device } = h.createDeviceAndSwapChain();
    const entries = /** @type {Record<string, any>} */ (h.d3d10);
    const mask = h.box.allocate(76);
    const call = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        entries[name].handler(args) >>> 0;
    assert.equal(call('D3D10StateBlockMaskEnableAll', [mask]), S_OK);
    assert.equal(h.box.memory.readU32(mask), 0xffffffff);
    assert.equal(call('D3D10StateBlockMaskDisableCapture', [mask, 13, 0, 1]), S_OK,
        'D3D10_DST_PS');
    assert.equal(h.box.services.readMemory(mask + 42, 1)[0], 0xfe);
    assert.equal(call('D3D10StateBlockMaskGetSetting', [mask, 13, 0]), 0);
    assert.equal(call('D3D10StateBlockMaskGetSetting', [mask, 7, 3]), 8);
    assert.equal(call('D3D10StateBlockMaskEnableCapture', [0, 5, 0, 1]), E_INVALIDARG);
    const other = h.box.allocate(76);
    const union = h.box.allocate(76);
    assert.equal(call('D3D10StateBlockMaskDisableAll', [other]), S_OK);
    assert.equal(call('D3D10StateBlockMaskUnion', [mask, other, union]), S_OK);
    assert.deepEqual([...h.box.services.readMemory(union, 76)],
        [...h.box.services.readMemory(mask, 76)]);
    assert.equal(call('D3D10StateBlockMaskIntersect', [mask, 0, union]), E_INVALIDARG);

    h.device(device, 'IASetPrimitiveTopology', [4]);
    const blockAt = h.box.place([0xdeadbeef]);
    assert.equal(call('D3D10CreateStateBlock', [device, mask, blockAt]), S_OK);
    const block = h.box.memory.readU32(blockAt);
    const blockCall = (/** @type {string} */ name, /** @type {number[]} */ args = [])=>
        h.box.call(block, slot(ID3D10STATEBLOCK_SLOTS, name), args);
    assert.equal(blockCall('Capture'), S_OK);
    h.device(device, 'IASetPrimitiveTopology', [1]);
    assert.equal(blockCall('Apply'), S_OK);
    const topology = h.box.place([0]);
    h.device(device, 'IAGetPrimitiveTopology', [topology]);
    assert.equal(h.box.memory.readU32(topology), 4);
    const owner = h.box.place([0]);
    assert.equal(blockCall('GetDevice', [owner]), S_OK);
    assert.equal(h.box.memory.readU32(owner), device, 'the device the program holds');
    assert.equal(blockCall('ReleaseAllDeviceObjects'), S_OK);
    for (const [name, bytes] of /** @type {[string, number][]} */ ([
        ['D3D10CreateStateBlock', 12], ['D3D10StateBlockMaskDifference', 12],
        ['D3D10StateBlockMaskDisableAll', 4], ['D3D10StateBlockMaskDisableCapture', 16],
        ['D3D10StateBlockMaskEnableAll', 4], ['D3D10StateBlockMaskEnableCapture', 16],
        ['D3D10StateBlockMaskGetSetting', 12], ['D3D10StateBlockMaskIntersect', 12],
        ['D3D10StateBlockMaskUnion', 12]]))
    {
        assert.equal(entries[name].argBytes, bytes, name);
    }
});

test('what this build cannot do says so in the slot rather than in a crash', ()=>{
    const h = seamed();
    const { device, swapChain } = h.createDeviceAndSwapChain();
    const out = h.box.place([0xdeadbeef]);
    assert.equal(h.device(device, 'OpenSharedResource',
        [1, h.box.placeGuid(IID.ID3D10Texture2D), out]), E_INVALIDARG,
    'nothing is shared, so no handle names a resource');
    assert.equal(h.box.memory.readU32(out), 0);
    const outAndBeyond = h.box.place([0xdeadbeef, 0xfeedface]);
    assert.equal(h.device(device, 'CreateGeometryShaderWithStreamOutput',
        [0, 0, 0, 0, 32, outAndBeyond, outAndBeyond + 4]), E_NOTIMPL);
    assert.equal(h.box.memory.readU32(outAndBeyond), 0, 'the sixth argument is the out');
    assert.equal(h.box.memory.readU32(outAndBeyond + 4), 0xfeedface,
        'the caller\'s next stack word is not an argument');
    assert.equal(h.swapChain(swapChain, 'SetFullscreenState', [1, 0]), 0x887a0022,
        'DXGI_ERROR_NOT_CURRENTLY_AVAILABLE: the display belongs to the page');
    assert.equal(h.swapChain(swapChain, 'SetFullscreenState', [0, 0]), S_OK);
    const modes = h.box.place([7]);
    assert.equal(h.swapChain(swapChain, 'ResizeTarget', [modes]), S_OK);
    assert.equal(h.swapChain(swapChain, 'ResizeTarget', [0]), DXGI_ERROR_INVALID_CALL);
    assert.equal(h.device(device, 'ResolveSubresource', [0, 0, 0, 0, 0]), 0,
        'a resolve of nothing is dropped');
});

// --- the effect framework ---

/**
 * A method of an effect interface without IUnknown: its first slot is its
 * own first method.
 *
 * @param {[string, number][]} slots @param {string} name
 */
const bareSlot = (slots, name)=>{
    const index = slots.findIndex(([entry])=>entry === name);
    assert.ok(index >= 0, `${name} is a slot`);
    return index;
};

/**
 * An effect made on a new device through the seam, and ways to call its
 * interfaces as a program does.
 *
 * @param {import('../d3d10/effect-fixtures.js').FixtureEffect} spec
 */
function effectOn(spec){
    const h = seamed();
    const { device, swapChain } = h.createDeviceAndSwapChain();
    const bytes = effectBinary(spec);
    const at = h.box.placeBytes(bytes);
    const outAt = h.box.place([0xdeadbeef]);
    /** @param {number} onDevice */
    const create = onDevice=>h.seam.effects.fromMemory(
        [at, bytes.length, 0, onDevice, 0, outAt]) >>> 0;
    /** The device's reference count, read by taking one and giving it back. */
    const references = ()=>{
        const count = h.box.call(device, 1);
        h.box.call(device, 2);
        return count - 1;
    };
    const baseline = references();
    assert.equal(create(device), S_OK);
    const effect = h.box.memory.readU32(outAt);
    /** @param {[string, number][]} slots */
    const on = slots=>(/** @type {number} */ pointer, /** @type {string} */ name,
        /** @type {number[]} */ args = [])=>h.box.call(pointer, bareSlot(slots, name), args);
    return {
        h, device, swapChain, effect, bytes, at, outAt, create, references, baseline,
        /** @param {string} name @param {number[]} [args] */
        fx: (name, args = [])=>h.box.call(effect, slot(ID3D10EFFECT_SLOTS, name), args),
        variable: on(ID3D10EFFECTVARIABLE_SLOTS),
        type: on(ID3D10EFFECTTYPE_SLOTS),
        technique: on(ID3D10EFFECTTECHNIQUE_SLOTS),
        pass: on(ID3D10EFFECTPASS_SLOTS),
        /** @param {string} kind */
        kind: kind=>on([...ID3D10EFFECTVARIABLE_SLOTS, ...EFFECT_VARIABLE_INTERFACES[kind].slots]),
        /** @param {number} pointer */
        text: pointer=>{
            const read = h.box.services.readMemory(pointer, 64);
            return String.fromCharCode(...read.subarray(0, read.indexOf(0)));
        },
        /** @param {number} pointer @param {number} count */
        dwords: (pointer, count)=>Array.from({ length: count },
            (_, index)=>h.box.memory.readU32(pointer + index * 4)),
        /** @param {string} text */
        named: text=>h.box.placeString(text),
    };
}

test('an effect is made on a device and walked through its interfaces', ()=>{
    // Wine's d3d10 effect tests, through the vtables a program calls.
    const E_FAIL = 0x80004005;
    const E_POINTER = 0x80004003;
    const vs = passThroughVertexShader();
    const e = effectOn({
        buffers: [{ name: 'cb', size: 32, variables: [
            { name: 'f1', offset: 0, semantic: 'SV_POSITION',
                type: { name: 'float', numeric: { layout: 'scalar', base: 'float' } } },
            { name: 'f2', offset: 16, semantic: 'COLOR0',
                annotations: [{ name: 's', type: { name: 'String', object: FX_KIND.STRING },
                    strings: ['f2_a'] }],
                type: { name: 'float4', numeric: { layout: 'vector', base: 'float',
                    columns: 4 } } },
        ] }],
        objects: [{ name: 'tex', type: { name: 'Texture2D', object: FX_KIND.TEXTURE2D } }],
        techniques: [{ name: 'Render', passes: [
            { name: 'P0' },
            { name: 'P1', assignments: [{ state: 6, shader: vs }] },
        ] }],
    });
    const { h, fx, variable, type, technique, pass, text, dwords, named } = e;
    assert.equal(e.create(0), 0x8876086c, 'D3DERR_INVALIDCALL without a device');
    assert.equal(h.box.memory.readU32(e.outAt), 0);
    const desc = h.box.allocate(64);

    assert.equal(fx('IsValid'), 1);
    assert.equal(fx('IsPool'), 0);
    assert.equal(fx('GetDesc', [0]), E_INVALIDARG);
    assert.equal(fx('GetDesc', [desc]), S_OK);
    assert.deepEqual(dwords(desc, 6), [0, 1, 0, 3, 0, 1]);

    const f2 = fx('GetVariableByName', [named('f2')]);
    assert.equal(fx('GetVariableBySemantic', [named('color0')]), f2);
    assert.equal(fx('GetVariableByIndex', [1]), f2);
    assert.equal(variable(f2, 'IsValid'), 1);
    assert.equal(variable(f2, 'GetDesc', [desc]), S_OK);
    assert.deepEqual([text(h.box.memory.readU32(desc)), text(h.box.memory.readU32(desc + 4))],
        ['f2', 'COLOR0']);
    assert.deepEqual(dwords(desc + 8, 4), [0, 1, 16, 0], 'flags, annotations, offset, bind point');
    assert.equal(variable(f2, 'AsVector'), f2, 'one pointer, its most derived interface');
    const notScalar = variable(f2, 'AsScalar');
    assert.notEqual(notScalar, f2);
    assert.equal(variable(notScalar, 'IsValid'), 0);
    const none = fx('GetVariableByIndex', [99]);
    assert.equal(fx('GetVariableByName', [0]), none);
    assert.equal(variable(none, 'GetDesc', [desc]), E_FAIL);

    const f2Type = variable(f2, 'GetType');
    assert.equal(type(f2Type, 'GetDesc', [desc]), S_OK);
    assert.equal(text(h.box.memory.readU32(desc)), 'float4');
    assert.deepEqual(dwords(desc + 4, 9), [1, 3, 0, 0, 1, 4, 16, 16, 16],
        'D3D10_SVC_VECTOR, D3D10_SVT_FLOAT, one row of four, sixteen bytes');
    const cb = fx('GetConstantBufferByIndex', [0]);
    assert.equal(variable(f2, 'GetParentConstantBuffer'), cb);
    assert.equal(variable(cb, 'GetMemberByIndex', [1]), f2);
    const cbType = variable(cb, 'GetType');
    assert.equal(type(cbType, 'GetDesc', [desc]), S_OK);
    assert.equal(text(h.box.memory.readU32(desc)), 'cbuffer');
    assert.equal(text(type(cbType, 'GetMemberName', [0])), 'f1');
    assert.equal(text(type(cbType, 'GetMemberSemantic', [1])), 'COLOR0');
    assert.equal(type(cbType, 'GetMemberName', [2]), 0);
    const annotation = variable(f2, 'GetAnnotationByIndex', [0]);
    assert.equal(variable(annotation, 'AsString'), annotation);

    const render = fx('GetTechniqueByName', [named('Render')]);
    assert.equal(fx('GetTechniqueByIndex', [0]), render);
    assert.equal(technique(render, 'GetDesc', [desc]), S_OK);
    assert.deepEqual([text(h.box.memory.readU32(desc)), ...dwords(desc + 4, 2)], ['Render', 2, 0]);
    const p1 = technique(render, 'GetPassByName', [named('P1')]);
    assert.equal(technique(render, 'GetPassByIndex', [1]), p1);
    assert.equal(pass(p1, 'GetDesc', [desc]), S_OK);
    assert.equal(text(h.box.memory.readU32(desc)), 'P1');
    const signature = h.box.memory.readU32(desc + 8);
    const size = h.box.memory.readU32(desc + 12);
    assert.deepEqual([...h.box.services.readMemory(signature, size)],
        [.../** @type {Uint8Array} */ (containerOf(vs, ['ISGN']))],
        'the vertex shader\'s input signature, in a container of its own');
    assert.equal(pass(p1, 'GetVertexShaderDesc', [desc]), S_OK);
    const anonymous = h.box.memory.readU32(desc);
    assert.equal(variable(anonymous, 'GetDesc', [desc]), S_OK);
    assert.equal(text(h.box.memory.readU32(desc)), '$Anonymous');
    const invalidPass = technique(render, 'GetPassByIndex', [2]);
    assert.equal(pass(invalidPass, 'IsValid'), 0);
    assert.equal(pass(invalidPass, 'Apply', [0]), E_FAIL);

    const shaderAt = h.box.place([0]);
    assert.equal(pass(p1, 'Apply', [0]), S_OK);
    h.device(e.device, 'VSGetShader', [shaderAt]);
    const bound = h.box.memory.readU32(shaderAt);
    assert.notEqual(bound, 0, 'the pass set its vertex shader');
    h.box.call(bound, 2);
    const mask = h.box.placeBytes(new Uint8Array(STATE_BLOCK_MASK_SIZE));
    assert.equal(technique(render, 'ComputeStateBlockMask', [mask]), S_OK);
    const written = h.box.services.readMemory(mask, STATE_BLOCK_MASK_SIZE);
    assert.ok(stateBlockMask.GetSetting(written, D3D10_DST.VS, 0));
    assert.ok(!stateBlockMask.GetSetting(written, D3D10_DST.PS, 0));

    const held = e.references();
    const deviceAt = h.box.place([0]);
    assert.equal(fx('GetDevice', [deviceAt]), S_OK);
    assert.equal(h.box.memory.readU32(deviceAt), e.device);
    assert.equal(e.references(), held + 1, 'GetDevice hands over a reference');
    h.box.call(e.device, 2);

    h.device(e.device, 'VSSetShader', [0]);
    assert.equal(h.box.call(e.effect, 2), 0, 'the last release');
    assert.equal(e.references(), e.baseline,
        'the effect gave back its own reference and those of everything it made');
    assert.equal(variable(f2, 'IsValid'), E_POINTER, 'its variables went with it');
    assert.equal(technique(render, 'IsValid'), E_POINTER);
    assert.equal(variable(none, 'IsValid'), 0, 'the invalid objects stay');

    // The entry point a program imports makes one the same way.
    assert.equal(h.d3d10.D3D10CreateEffectFromMemory.handler([e.at, e.bytes.length, 0, e.device,
        0, e.outAt]) >>> 0, S_OK);
    const imported = h.box.memory.readU32(e.outAt);
    assert.equal(h.box.call(imported, slot(ID3D10EFFECT_SLOTS, 'IsValid')), 1);
    assert.equal(h.box.call(imported, 2), 0);
    assert.equal(e.references(), e.baseline);
    const pool = h.box.place([0]);
    assert.equal(h.d3d10.D3D10CreateEffectFromMemory.handler([e.at, e.bytes.length, 0, e.device,
        pool, e.outAt]) >>> 0, E_NOTIMPL, 'the child of a pool is refused');
    assert.equal(h.box.memory.readU32(e.outAt), 0);
    assert.equal((/** @type {Record<string, any>} */ (h.seam.libraries['D3D10_1.dll']))
        .D3D10CreateEffectFromMemory, h.d3d10.D3D10CreateEffectFromMemory,
    'd3d10_1.dll\'s is d3d10.dll\'s');
});

test('an effect variable\'s typed views are called through its vtable', ()=>{
    // Wine's effect tests for each kind of variable, through the slots a
    // program calls.
    const E_FAIL = 0x80004005;
    const D3DERR_INVALIDCALL = 0x8876086c;
    const vs = passThroughVertexShader();
    const e = effectOn({
        buffers: [{ name: 'cb', size: 112, variables: [
            { name: 'f', offset: 0, type: { name: 'float',
                numeric: { layout: 'scalar', base: 'float' } } },
            { name: 'i_a', offset: 16, type: { name: 'int', elements: 2,
                numeric: { layout: 'scalar', base: 'int' } } },
            { name: 'v_a', offset: 48, type: { name: 'float2', elements: 2,
                numeric: { layout: 'vector', base: 'float', columns: 2 } } },
            { name: 'm', offset: 80, type: { name: 'float2x2',
                numeric: { layout: 'matrix', base: 'float', rows: 2, columns: 2 } } },
        ] }, { name: 'tb', size: 16, textureBuffer: true, variables: [{ name: 'g', offset: 0,
            type: { name: 'float', numeric: { layout: 'scalar', base: 'float' } } }] }],
        objects: [
            { name: 's', type: { name: 'String', object: FX_KIND.STRING },
                elements: [{ string: 'STRING' }] },
            { name: 'tex', type: { name: 'Texture2D', object: FX_KIND.TEXTURE2D, elements: 2 } },
            { name: 'v', type: { name: 'VertexShader', object: FX_KIND.VERTEXSHADER },
                elements: [{ shader: vs }] },
            { name: 'bs', type: { name: 'BlendState', object: FX_KIND.BLEND },
                elements: [{ assignments: [
                    { state: 0x25, constant: [[CONSTANT_TYPE.BOOL, 1]] },
                    { state: 0x26, constant: [[CONSTANT_TYPE.INT, 2]] }] }] },
        ],
    });
    const { h, fx, variable, named, dwords } = e;
    const read = (/** @type {number} */ at)=>h.box.memory.readU32(at);
    const out = h.box.allocate(64);
    const raw = h.box.allocate(32);

    const scalar = e.kind('scalar');
    const f = fx('GetVariableByName', [named('f')]);
    assert.equal(scalar(f, 'SetFloat', floatBits([5])), S_OK, 'a float passed as its bits');
    assert.equal(scalar(f, 'GetFloat', [out]), S_OK);
    assert.equal(read(out), floatBits([5])[0]);
    assert.equal(scalar(f, 'GetInt', [out]), S_OK);
    assert.equal(read(out), 5);
    assert.equal(scalar(f, 'SetBool', [1]), S_OK);
    assert.equal(scalar(f, 'GetBool', [out]), S_OK);
    assert.equal(read(out), 0xffffffff);
    assert.equal(scalar(f, 'GetFloat', [0]), E_INVALIDARG);
    const array = fx('GetVariableByName', [named('i_a')]);
    assert.equal(scalar(array, 'SetIntArray', [h.box.place([7, 8]), 1, 2]), S_OK);
    assert.equal(scalar(array, 'GetIntArray', [out, 1, 2]), S_OK);
    assert.deepEqual(dwords(out, 2), [7, 8], 'a scalar array\'s offset goes unused');
    assert.equal(variable(array, 'GetRawValue', [raw, 0, 20]), S_OK);
    assert.deepEqual(dwords(raw, 5), [7, 0, 0, 0, 8]);
    // A count or offset past the buffer goes no further than it, rather
    // than a caller's garbage sizing what the host allocates.
    const wide = h.box.allocate(128);
    assert.equal(scalar(array, 'GetIntArray', [wide, 0, 0xffffffff]), S_OK);
    assert.equal(variable(array, 'GetRawValue', [wide, 0, 0x7fffffff]), S_OK);
    assert.equal(variable(array, 'SetRawValue', [wide, 0x1000, 0x7fffffff]), S_OK);
    assert.deepEqual(dwords(raw, 5), [7, 0, 0, 0, 8]);

    const vector = e.kind('vector');
    const vectors = fx('GetVariableByName', [named('v_a')]);
    assert.equal(vector(vectors, 'SetFloatVectorArray', [h.box.place(floatBits([1, 2])), 1, 1]),
        S_OK);
    assert.equal(vector(vectors, 'SetIntVector', [h.box.place([3, 4])]), S_OK);
    assert.equal(vector(vectors, 'GetFloatVectorArray', [out, 0, 2]), S_OK);
    assert.deepEqual(dwords(out, 4), floatBits([3, 4, 1, 2]), 'a vector array\'s is honoured');

    const matrix = e.kind('matrix');
    const m = fx('GetVariableByName', [named('m')]);
    assert.equal(matrix(m, 'SetMatrix', [h.box.place(floatBits([1, 2, 0, 0, 3, 4, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0]))]), S_OK);
    const back = h.box.place(new Array(16).fill(0xdeadbeef));
    assert.equal(matrix(m, 'GetMatrixTranspose', [back]), S_OK);
    assert.deepEqual([0, 1, 4, 5, 2].map(at=>read(back + at * 4)),
        [...floatBits([1, 3, 2, 4]), 0xdeadbeef], 'the entries it has, and no others');
    assert.equal(variable(m, 'GetRawValue', [raw, 0, 24]), S_OK);
    assert.deepEqual(dwords(raw, 6), [...floatBits([1, 3]), 0, 0, ...floatBits([2, 4])],
        'a column a register');

    const string = e.kind('string');
    const s = fx('GetVariableByName', [named('s')]);
    assert.equal(string(s, 'GetString', [0]), E_INVALIDARG);
    assert.equal(string(s, 'GetString', [out]), S_OK);
    assert.equal(e.text(read(out)), 'STRING');
    h.box.memory.writeU32(out, 0xdeadbeef);
    assert.equal(string(variable(f, 'AsString'), 'GetString', [out]), E_FAIL);
    assert.equal(read(out), 0xdeadbeef, 'the invalid variable leaves the pointer');

    const resource = e.kind('shaderResource');
    const tex = fx('GetVariableByName', [named('tex')]);
    const textureAt = h.box.place([0]);
    assert.equal(h.device(e.device, 'CreateTexture2D', [h.box.place([4, 4, 1, 1,
        DXGI_FORMAT.R8G8B8A8_UNORM, 1, 0, D3D10_USAGE.DEFAULT, D3D10_BIND.SHADER_RESOURCE, 0, 0]),
    0, textureAt]), S_OK);
    const viewAt = h.box.place([0]);
    assert.equal(h.device(e.device, 'CreateShaderResourceView', [read(textureAt), 0, viewAt]),
        S_OK);
    const view = read(viewAt);
    assert.equal(resource(tex, 'SetResourceArray', [h.box.place([view]), 1, 1]), S_OK);
    const views = h.box.place([0xdeadbeef, 0xdeadbeef]);
    assert.equal(resource(tex, 'GetResourceArray', [views, 0, 2]), S_OK);
    assert.deepEqual(dwords(views, 2), [0, view], 'the program\'s own pointer, at the offset');
    assert.equal(h.box.call(view, 2), 2, 'handed out with a reference; the effect holds one');
    assert.equal(resource(variable(tex, 'GetElement', [1]), 'GetResource', [out]), S_OK);
    assert.equal(read(out), view);
    h.box.call(view, 2);
    assert.equal(resource(tex, 'GetResourceArray', [wide, 1, 0xffffffff]), S_OK);
    assert.equal(read(wide), view, 'as many as the variable has');
    h.box.call(view, 2);

    const cbuffer = e.kind('constantBuffer');
    const cb = fx('GetConstantBufferByName', [named('cb')]);
    assert.equal(cbuffer(cb, 'GetConstantBuffer', [out]), S_OK);
    const buffer = read(out);
    const bufferDesc = h.box.allocate(20);
    h.box.call(buffer, slot(ID3D10BUFFER_SLOTS, 'GetDesc'), [bufferDesc]);
    assert.deepEqual(dwords(bufferDesc, 5), [112, D3D10_USAGE.DEFAULT,
        D3D10_BIND.CONSTANT_BUFFER, 0, 0]);
    h.box.call(buffer, 2);
    assert.equal(cbuffer(cb, 'GetTextureBuffer', [out]), D3DERR_INVALIDCALL);
    const tb = fx('GetConstantBufferByName', [named('tb')]);
    assert.equal(cbuffer(tb, 'GetConstantBuffer', [out]), D3DERR_INVALIDCALL);
    const noBuffer = fx('GetConstantBufferByIndex', [100]);
    assert.equal(cbuffer(noBuffer, 'GetConstantBuffer', [out]), E_FAIL);
    assert.equal(cbuffer(noBuffer, 'GetTextureBuffer', [out]), E_FAIL);

    const shader = e.kind('shader');
    const v = fx('GetVariableByName', [named('v')]);
    const shaderDesc = h.box.allocate(28);
    assert.equal(shader(v, 'GetShaderDesc', [0, shaderDesc]), S_OK);
    const [signature, inline, bytecode, length, streamOutput, inputs, outputs] =
        dwords(shaderDesc, 7);
    assert.deepEqual([inline, length, streamOutput, inputs, outputs], [0, vs.length, 0, 1, 1]);
    assert.deepEqual([...h.box.services.readMemory(bytecode, vs.length)], [...vs]);
    const isgn = /** @type {Uint8Array} */ (containerOf(vs, ['ISGN']));
    assert.deepEqual([...h.box.services.readMemory(signature, isgn.length)], [...isgn]);
    const shaderAt = h.box.place([0xdeadbeef]);
    assert.equal(shader(v, 'GetPixelShader', [0, shaderAt]), D3DERR_INVALIDCALL);
    assert.equal(read(shaderAt), 0);
    assert.equal(shader(v, 'GetVertexShader', [0, shaderAt]), S_OK);
    assert.notEqual(read(shaderAt), 0);
    h.box.call(read(shaderAt), 2);
    const parameter = h.box.allocate(24);
    assert.equal(shader(v, 'GetOutputSignatureElementDesc', [0, 0, parameter]), S_OK);
    assert.equal(e.text(read(parameter)), 'SV_POSITION');
    assert.equal(read(parameter + 12), 1, 'D3D10_NAME_POSITION');

    const blend = e.kind('blend');
    const bs = fx('GetVariableByName', [named('bs')]);
    const store = h.box.allocate(0x44);
    assert.equal(blend(bs, 'GetBackingStore', [0, store]), S_OK);
    assert.deepEqual(dwords(store + 36, 2), [2, 6],
        'its own source blend, and the effect\'s default destination');
    const stateAt = h.box.place([0]);
    assert.equal(blend(bs, 'GetBlendState', [0, stateAt]), S_OK);
    const state = read(stateAt);
    const described = h.box.allocate(0x44);
    h.box.call(state, slot(ID3D10STATE_SLOTS, 'GetDesc'), [described]);
    assert.deepEqual([...h.box.services.readMemory(described, 0x44)],
        [...h.box.services.readMemory(store, 0x44)], 'the state made from the store');
    h.box.call(state, 2);
    assert.equal(blend(bs, 'GetBlendState', [1, stateAt]), E_FAIL);

    const nothing = fx('GetVariableByName', [named('nothing')]);
    assert.equal(variable(nothing, 'GetRawValue', [raw, 0, 4]), E_FAIL);
    assert.equal(variable(nothing, 'SetRawValue', [raw, 0, 4]), E_FAIL);

    h.box.call(view, 2);
    h.box.call(read(textureAt), 2);
    assert.equal(h.box.call(e.effect, 2), 0);
    assert.equal(e.references(), e.baseline, 'every reference handed out came back');
});

// --- view descriptions, through guest memory ---

/** What a stack the program never cleared holds in the union's other dwords. */
const STALE = 0xcdcdcdcd;

/**
 * A view description in guest memory the way Wine's get_rtv_desc,
 * get_dsv_desc and get_srv_desc fill one (d3d10core.c:235-560): the head, then
 * only the members of the dimension asked for, laid out as the SDK header lays
 * that dimension's union out -- written here from the header, not from the
 * table the seam reads with -- and stale dwords in every other place.
 *
 * @param {ReturnType<typeof seamed>} h
 * @param {'rtv' | 'dsv' | 'srv'} kind
 * @param {number[]} entry  Wine's {format, dimension, mip, (mip count,) layer, layer count}.
 * @returns {number} where it was placed
 */
function placeViewDesc(h, kind, entry){
    const [format, dimension, ...rest] = entry;
    /** @type {Record<string, Record<number, (values: number[]) => number[]>>} */
    const layouts = {
        // D3D10_RTV_DIMENSION: TEX1D 2, TEX1DARRAY 3, TEX2D 4, TEX2DARRAY 5,
        // TEX2DMS 6, TEX2DMSARRAY 7, TEX3D 8.
        rtv: {
            2: ([mip])=>[mip], 3: ([mip, layer, count])=>[mip, layer, count],
            4: ([mip])=>[mip], 5: ([mip, layer, count])=>[mip, layer, count],
            6: ()=>[], 7: ([, layer, count])=>[layer, count],
            8: ([mip, layer, count])=>[mip, layer, count],
        },
        // D3D10_DSV_DIMENSION: TEX1D 1, TEX1DARRAY 2, TEX2D 3, TEX2DARRAY 4,
        // TEX2DMS 5, TEX2DMSARRAY 6.
        dsv: {
            1: ([mip])=>[mip], 2: ([mip, layer, count])=>[mip, layer, count],
            3: ([mip])=>[mip], 4: ([mip, layer, count])=>[mip, layer, count],
            5: ()=>[], 6: ([, layer, count])=>[layer, count],
        },
        // D3D10_SRV_DIMENSION: as the render target's, and TEXTURECUBE 9.
        srv: {
            2: ([mip, levels])=>[mip, levels],
            3: ([mip, levels, layer, count])=>[mip, levels, layer, count],
            4: ([mip, levels])=>[mip, levels],
            5: ([mip, levels, layer, count])=>[mip, levels, layer, count],
            6: ()=>[], 7: ([, , layer, count])=>[layer, count],
            8: ([mip, levels])=>[mip, levels], 9: ([mip, levels])=>[mip, levels],
        },
    };
    const members = (layouts[kind][dimension] ?? (()=>[]))(rest.map(value=>value >>> 0));
    const union = [STALE, STALE, STALE, STALE];
    members.forEach((value, index)=>{
        union[index] = value;
    });
    return h.box.place([format, dimension, ...union]);
}

/**
 * The description a view reports, read at the SDK header's offsets for its
 * dimension, as Wine's check_*_desc reads it, with what lies past the
 * structure: a description written one dword too long shows there.
 *
 * @param {ReturnType<typeof seamed>} h
 * @param {'rtv' | 'dsv' | 'srv'} kind
 * @param {number} view
 */
function reportedViewDesc(h, kind, view){
    const size = kind === 'srv' ? 6 : 5;
    const out = h.box.place(Array(size + 1).fill(STALE));
    h.box.call(view, slot(ID3D10VIEW_SLOTS, 'GetDesc'), [out]);
    const words = Array.from({ length: size + 1 },
        (_, index)=>h.box.memory.readU32(out + index * 4));
    return { words: words.slice(0, size), past: words[size] };
}

/**
 * @param {ReturnType<typeof seamed>} h
 * @param {number} device
 * @param {{ mips: number, slices: number, format: number, bind: number, misc?: number,
 *           volume?: boolean }} texture
 */
function viewTexture(h, device, texture){
    const out = h.box.place([0]);
    const hr = texture.volume
        ? h.device(device, 'CreateTexture3D', [h.box.place([64, 64, texture.slices,
            texture.mips, texture.format, D3D10_USAGE.DEFAULT, texture.bind, 0, 0]), 0, out])
        : h.device(device, 'CreateTexture2D', [h.box.place([512, 512, texture.mips,
            texture.slices, texture.format, 1, 0, D3D10_USAGE.DEFAULT, texture.bind, 0,
            texture.misc ?? 0]), 0, out]);
    assert.equal(hr, S_OK);
    return h.box.memory.readU32(out);
}

const RGBA8 = DXGI_FORMAT.R8G8B8A8_UNORM;
const RGBA8_TL = DXGI_FORMAT.R8G8B8A8_TYPELESS;
const D24S8 = DXGI_FORMAT.D24_UNORM_S8_UINT;
const ALL = 0xffffffff;

/**
 * Runs one of Wine's view tables through the seam: each valid row creates the
 * view from a description with stale dwords beside its members and reads back
 * the expected description at the header's offsets; each invalid row is
 * E_INVALIDARG with the out pointer cleared.
 *
 * @param {'rtv' | 'dsv' | 'srv'} kind
 * @param {string} method
 * @param {number} bind
 * @param {[any, number[] | null, number[]][]} valid  texture, description (null: default), expected
 * @param {[any, number[]][]} invalid
 */
function runViewTable(kind, method, bind, valid, invalid){
    const h = seamed();
    const { device } = h.createDeviceAndSwapChain();
    const size = kind === 'srv' ? 6 : 5;
    for (const [index, [texture, desc, expected]] of valid.entries())
    {
        const resource = viewTexture(h, device, { ...texture, bind });
        const out = h.box.place([0xdeadbeef]);
        assert.equal(h.device(device, method, [resource, desc ? placeViewDesc(h, kind, desc) : 0,
            out]), S_OK, `row ${index}`);
        const view = h.box.memory.readU32(out);
        const { words, past } = reportedViewDesc(h, kind, view);
        const wanted = [...expected.map(value=>value >>> 0)];
        // Wine's check_*_desc compares the head and the dimension's members;
        // the rest of the union is zero here, as it is in a description
        // Windows built and the program cleared before asking.
        while (wanted.length < size)
        {
            wanted.push(0);
        }
        assert.deepEqual(words, wanted, `row ${index}: the description at the header's offsets`);
        assert.equal(past, STALE, `row ${index}: nothing written past the structure`);
        h.box.call(view, 2);
        h.box.call(resource, 2);
    }
    for (const [index, [texture, desc]] of invalid.entries())
    {
        const resource = viewTexture(h, device, { ...texture, bind });
        const out = h.box.place([0xdeadbeef]);
        assert.equal(h.device(device, method, [resource, placeViewDesc(h, kind, desc), out]),
            E_INVALIDARG, `invalid row ${index}`);
        assert.equal(h.box.memory.readU32(out), 0, `invalid row ${index}: no view`);
        h.box.call(resource, 2);
    }
}

test('render-target views: Wine\'s table of descriptions, each read by its own dimension'
    + ' (test_create_rendertarget_view, d3d10core.c:2894-2987)', ()=>{
    const t = (/** @type {number} */ mips, /** @type {number} */ slices,
        /** @type {number} */ format)=>({ mips, slices, format });
    const v = (/** @type {number} */ mips, /** @type {number} */ slices,
        /** @type {number} */ format)=>({ mips, slices, format, volume: true });
    const [TEX_1D, TEX_1D_ARRAY, TEX_2D, TEX_2D_ARRAY, TEX_2DMS, TEX_2DMS_ARR, TEX_3D] =
        [2, 3, 4, 5, 6, 7, 8];
    runViewTable('rtv', 'CreateRenderTargetView', D3D10_BIND.RENDER_TARGET, [
        [t(1, 1, RGBA8), null, [RGBA8, TEX_2D, 0]],
        [t(10, 1, RGBA8), null, [RGBA8, TEX_2D, 0]],
        [t(10, 1, RGBA8), [0, TEX_2D, 0], [RGBA8, TEX_2D, 0]],
        [t(10, 1, RGBA8), [0, TEX_2D, 1], [RGBA8, TEX_2D, 1]],
        [t(10, 1, RGBA8), [0, TEX_2D, 9], [RGBA8, TEX_2D, 9]],
        [t(1, 1, RGBA8_TL), [RGBA8, TEX_2D, 0], [RGBA8, TEX_2D, 0]],
        [t(10, 1, RGBA8_TL), [RGBA8, TEX_2D, 0], [RGBA8, TEX_2D, 0]],
        [t(1, 4, RGBA8), null, [RGBA8, TEX_2D_ARRAY, 0, 0, 4]],
        [t(10, 4, RGBA8), null, [RGBA8, TEX_2D_ARRAY, 0, 0, 4]],
        [t(10, 4, RGBA8), [0, TEX_2D_ARRAY, 0, 0, ALL], [RGBA8, TEX_2D_ARRAY, 0, 0, 4]],
        [t(10, 4, RGBA8), [0, TEX_2D_ARRAY, 1, 0, ALL], [RGBA8, TEX_2D_ARRAY, 1, 0, 4]],
        [t(10, 4, RGBA8), [0, TEX_2D_ARRAY, 9, 0, ALL], [RGBA8, TEX_2D_ARRAY, 9, 0, 4]],
        [t(10, 4, RGBA8), [0, TEX_2D_ARRAY, 0, 1, ALL], [RGBA8, TEX_2D_ARRAY, 0, 1, 3]],
        [t(10, 4, RGBA8), [0, TEX_2D_ARRAY, 0, 3, ALL], [RGBA8, TEX_2D_ARRAY, 0, 3, 1]],
        [t(1, 1, RGBA8), [0, TEX_2DMS], [RGBA8, TEX_2DMS]],
        [t(1, 4, RGBA8), [0, TEX_2DMS], [RGBA8, TEX_2DMS]],
        [t(10, 4, RGBA8), [0, TEX_2DMS], [RGBA8, TEX_2DMS]],
        [t(1, 1, RGBA8), [0, TEX_2DMS_ARR, 0, 0, 1], [RGBA8, TEX_2DMS_ARR, 0, 1]],
        [t(1, 1, RGBA8), [0, TEX_2DMS_ARR, 0, 0, ALL], [RGBA8, TEX_2DMS_ARR, 0, 1]],
        [t(10, 4, RGBA8), [0, TEX_2DMS_ARR, 0, 0, 1], [RGBA8, TEX_2DMS_ARR, 0, 1]],
        [t(10, 4, RGBA8), [0, TEX_2DMS_ARR, 0, 0, 4], [RGBA8, TEX_2DMS_ARR, 0, 4]],
        [t(10, 4, RGBA8), [0, TEX_2DMS_ARR, 0, 0, ALL], [RGBA8, TEX_2DMS_ARR, 0, 4]],
        [v(1, 6, RGBA8), null, [RGBA8, TEX_3D, 0, 0, 6]],
        [v(2, 6, RGBA8), null, [RGBA8, TEX_3D, 0, 0, 6]],
        [v(2, 6, RGBA8), [0, TEX_3D, 0, 0, ALL], [RGBA8, TEX_3D, 0, 0, 6]],
        [v(2, 4, RGBA8), [0, TEX_3D, 1, 0, ALL], [RGBA8, TEX_3D, 1, 0, 2]],
        [v(2, 4, RGBA8), [0, TEX_3D, 0, 1, ALL], [RGBA8, TEX_3D, 0, 1, 3]],
        [v(2, 4, RGBA8), [0, TEX_3D, 0, 3, ALL], [RGBA8, TEX_3D, 0, 3, 1]],
        [v(2, 4, RGBA8), [0, TEX_3D, 1, 1, 1], [RGBA8, TEX_3D, 1, 1, 1]],
        [v(2, 4, RGBA8), [0, TEX_3D, 1, 1, ALL], [RGBA8, TEX_3D, 1, 1, 1]],
        [v(6, 8, RGBA8), [0, TEX_3D, 1, 0, ALL], [RGBA8, TEX_3D, 1, 0, 4]],
        [v(6, 8, RGBA8), [0, TEX_3D, 5, 0, ALL], [RGBA8, TEX_3D, 5, 0, 1]],
    ], [
        [t(1, 1, RGBA8), [RGBA8, 0]],
        [t(6, 4, RGBA8), [RGBA8, 0]],
        [t(1, 1, RGBA8), [RGBA8, TEX_1D, 0]],
        [t(1, 1, RGBA8), [RGBA8, TEX_1D_ARRAY, 0, 0, 1]],
        [t(1, 1, RGBA8), [RGBA8, TEX_3D, 0, 0, 1]],
        [t(1, 1, RGBA8), [RGBA8_TL, TEX_2D, 0]],
        [t(1, 1, RGBA8_TL), [0, TEX_2D, 0]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2D, 1]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2D_ARRAY, 0, 0, 0]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2D_ARRAY, 1, 0, 1]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2D_ARRAY, 0, 0, 2]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2D_ARRAY, 0, 1, 1]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2DMS_ARR, 0, 0, 2]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2DMS_ARR, 0, 1, 1]],
        [v(1, 9, RGBA8), [RGBA8, TEX_2D, 0]],
        [v(1, 9, RGBA8), [RGBA8, TEX_2D_ARRAY, 0, 0, 1]],
        [v(1, 1, RGBA8), [RGBA8, TEX_3D, 0, 0, 0]],
        [v(1, 1, RGBA8), [RGBA8, TEX_3D, 1, 0, 1]],
        [v(1, 9, RGBA8), [RGBA8_TL, TEX_3D, 0, 0, 1]],
        [v(4, 8, RGBA8), [RGBA8, TEX_3D, 0, 0, 9]],
        [v(4, 8, RGBA8), [RGBA8, TEX_3D, 3, 0, 2]],
        [v(4, 8, RGBA8), [RGBA8, TEX_3D, 1, 0, 8]],
        [v(4, 8, RGBA8), [RGBA8, TEX_3D, 0, 8, ALL]],
        [v(4, 8, RGBA8), [RGBA8, TEX_3D, 3, 1, ALL]],
    ]);
});

test('depth-stencil views: Wine\'s table of descriptions, each read by its own dimension'
    + ' (test_create_depthstencil_view, d3d10core.c:2616-2672)', ()=>{
    const t = (/** @type {number} */ mips, /** @type {number} */ slices,
        /** @type {number} */ format)=>({ mips, slices, format });
    const R24G8_TL = DXGI_FORMAT.R24G8_TYPELESS;
    const [TEX_1D, TEX_1D_ARRAY, TEX_2D, TEX_2D_ARRAY, TEX_2DMS, TEX_2DMS_ARR] =
        [1, 2, 3, 4, 5, 6];
    runViewTable('dsv', 'CreateDepthStencilView', D3D10_BIND.DEPTH_STENCIL, [
        [t(1, 1, D24S8), null, [D24S8, TEX_2D, 0]],
        [t(10, 1, D24S8), null, [D24S8, TEX_2D, 0]],
        [t(10, 1, D24S8), [0, TEX_2D, 0], [D24S8, TEX_2D, 0]],
        [t(10, 1, D24S8), [0, TEX_2D, 1], [D24S8, TEX_2D, 1]],
        [t(10, 1, D24S8), [0, TEX_2D, 9], [D24S8, TEX_2D, 9]],
        [t(1, 1, R24G8_TL), [D24S8, TEX_2D, 0], [D24S8, TEX_2D, 0]],
        [t(10, 1, R24G8_TL), [D24S8, TEX_2D, 0], [D24S8, TEX_2D, 0]],
        [t(1, 4, D24S8), null, [D24S8, TEX_2D_ARRAY, 0, 0, 4]],
        [t(10, 4, D24S8), null, [D24S8, TEX_2D_ARRAY, 0, 0, 4]],
        [t(10, 4, D24S8), [0, TEX_2D_ARRAY, 0, 0, ALL], [D24S8, TEX_2D_ARRAY, 0, 0, 4]],
        [t(10, 4, D24S8), [0, TEX_2D_ARRAY, 5, 0, ALL], [D24S8, TEX_2D_ARRAY, 5, 0, 4]],
        [t(10, 4, D24S8), [0, TEX_2D_ARRAY, 0, 2, ALL], [D24S8, TEX_2D_ARRAY, 0, 2, 2]],
        [t(1, 1, D24S8), [0, TEX_2DMS], [D24S8, TEX_2DMS]],
        [t(10, 4, D24S8), [0, TEX_2DMS], [D24S8, TEX_2DMS]],
        [t(1, 1, D24S8), [0, TEX_2DMS_ARR, 0, 0, ALL], [D24S8, TEX_2DMS_ARR, 0, 1]],
        [t(10, 4, D24S8), [0, TEX_2DMS_ARR, 0, 0, 1], [D24S8, TEX_2DMS_ARR, 0, 1]],
        [t(10, 4, D24S8), [0, TEX_2DMS_ARR, 0, 0, ALL], [D24S8, TEX_2DMS_ARR, 0, 4]],
    ], [
        [t(1, 1, D24S8), [D24S8, 0]],
        [t(6, 4, D24S8), [D24S8, 0]],
        [t(1, 1, D24S8), [D24S8, TEX_1D, 0]],
        [t(1, 1, D24S8), [D24S8, TEX_1D_ARRAY, 0, 0, 1]],
        [t(1, 1, D24S8), [R24G8_TL, TEX_2D, 0]],
        [t(1, 1, R24G8_TL), [0, TEX_2D, 0]],
        [t(1, 1, D24S8), [D24S8, TEX_2D, 1]],
        [t(1, 1, D24S8), [D24S8, TEX_2D_ARRAY, 0, 0, 0]],
        [t(1, 1, D24S8), [D24S8, TEX_2D_ARRAY, 1, 0, 1]],
        [t(1, 1, D24S8), [D24S8, TEX_2D_ARRAY, 0, 0, 2]],
        [t(1, 1, D24S8), [D24S8, TEX_2D_ARRAY, 0, 1, 1]],
        [t(1, 1, D24S8), [D24S8, TEX_2DMS_ARR, 0, 0, 2]],
        [t(1, 1, D24S8), [D24S8, TEX_2DMS_ARR, 0, 1, 1]],
    ]);
});

test('shader-resource views: Wine\'s table of descriptions, each read by its own dimension'
    + ' (test_create_shader_resource_view, d3d10core.c:3542-3632)', ()=>{
    const t = (/** @type {number} */ mips, /** @type {number} */ slices,
        /** @type {number} */ format)=>({ mips, slices, format });
    const v = (/** @type {number} */ mips, /** @type {number} */ slices,
        /** @type {number} */ format)=>({ mips, slices, format, volume: true });
    const [TEX_1D, TEX_1D_ARRAY, TEX_2D, TEX_2D_ARRAY, TEX_2DMS, TEX_2DMS_ARR, TEX_3D] =
        [2, 3, 4, 5, 6, 7, 8];
    runViewTable('srv', 'CreateShaderResourceView', D3D10_BIND.SHADER_RESOURCE, [
        [t(10, 1, RGBA8), null, [RGBA8, TEX_2D, 0, 10]],
        [t(10, 1, RGBA8), [0, TEX_2D, 0, ALL], [RGBA8, TEX_2D, 0, 10]],
        [t(10, 1, RGBA8), [RGBA8, TEX_2D, 0, ALL], [RGBA8, TEX_2D, 0, 10]],
        [t(10, 1, RGBA8), [0, TEX_2D, 0, 10], [RGBA8, TEX_2D, 0, 10]],
        [t(1, 1, RGBA8_TL), [RGBA8, TEX_2D, 0, ALL], [RGBA8, TEX_2D, 0, 1]],
        [t(10, 1, RGBA8_TL), [RGBA8, TEX_2D, 0, ALL], [RGBA8, TEX_2D, 0, 10]],
        [t(10, 4, RGBA8), null, [RGBA8, TEX_2D_ARRAY, 0, 10, 0, 4]],
        [t(10, 4, RGBA8), [0, TEX_2D_ARRAY, 0, ALL, 0, ALL], [RGBA8, TEX_2D_ARRAY, 0, 10, 0, 4]],
        [t(10, 4, RGBA8), [0, TEX_2D_ARRAY, 1, ALL, 0, ALL], [RGBA8, TEX_2D_ARRAY, 1, 9, 0, 4]],
        [t(10, 4, RGBA8), [0, TEX_2D_ARRAY, 9, ALL, 0, ALL], [RGBA8, TEX_2D_ARRAY, 9, 1, 0, 4]],
        [t(10, 4, RGBA8), [0, TEX_2D_ARRAY, 0, ALL, 1, ALL], [RGBA8, TEX_2D_ARRAY, 0, 10, 1, 3]],
        [t(10, 4, RGBA8), [0, TEX_2D_ARRAY, 0, ALL, 3, ALL], [RGBA8, TEX_2D_ARRAY, 0, 10, 3, 1]],
        [t(1, 1, RGBA8), [0, TEX_2DMS], [RGBA8, TEX_2DMS]],
        [t(10, 4, RGBA8), [0, TEX_2DMS], [RGBA8, TEX_2DMS]],
        [t(1, 1, RGBA8), [0, TEX_2DMS_ARR, 0, 1, 0, 1], [RGBA8, TEX_2DMS_ARR, 0, 1]],
        [t(1, 1, RGBA8), [0, TEX_2DMS_ARR, 0, 1, 0, ALL], [RGBA8, TEX_2DMS_ARR, 0, 1]],
        [t(10, 4, RGBA8), [0, TEX_2DMS_ARR, 0, 1, 0, 4], [RGBA8, TEX_2DMS_ARR, 0, 4]],
        [t(10, 4, RGBA8), [0, TEX_2DMS_ARR, 0, 1, 0, ALL], [RGBA8, TEX_2DMS_ARR, 0, 4]],
        [v(1, 12, RGBA8), null, [RGBA8, TEX_3D, 0, 1]],
        [v(1, 12, RGBA8), [0, TEX_3D, 0, 1], [RGBA8, TEX_3D, 0, 1]],
        [v(1, 12, RGBA8), [0, TEX_3D, 0, ALL], [RGBA8, TEX_3D, 0, 1]],
        [v(4, 12, RGBA8), [0, TEX_3D, 0, ALL], [RGBA8, TEX_3D, 0, 4]],
    ], [
        [t(1, 1, RGBA8), [RGBA8, 0]],
        [t(6, 4, RGBA8), [RGBA8, 0]],
        [t(1, 1, RGBA8), [RGBA8, TEX_1D, 0, 1]],
        [t(1, 1, RGBA8), [RGBA8, TEX_1D_ARRAY, 0, 1, 0, 1]],
        [t(1, 1, RGBA8), [RGBA8, TEX_3D, 0, 1]],
        [t(1, 1, RGBA8), [RGBA8_TL, TEX_2D, 0, ALL]],
        [t(1, 1, RGBA8_TL), [0, TEX_2D, 0, ALL]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2D, 0, 0]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2D, 0, 2]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2D, 1, 1]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2D_ARRAY, 0, 0, 0, 0]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2D_ARRAY, 0, 0, 0, 1]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2D_ARRAY, 0, 1, 0, 0]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2D_ARRAY, 0, 2, 0, 1]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2D_ARRAY, 1, 1, 0, 1]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2D_ARRAY, 0, 1, 0, 2]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2D_ARRAY, 0, 1, 1, 1]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2DMS_ARR, 0, 1, 0, 2]],
        [t(1, 1, RGBA8), [RGBA8, TEX_2DMS_ARR, 0, 1, 1, 1]],
        [v(1, 9, RGBA8), [RGBA8, TEX_2D, 0, 1]],
        [v(1, 9, RGBA8), [RGBA8, TEX_2D_ARRAY, 0, 1, 0, 1]],
        [v(1, 1, RGBA8), [RGBA8, TEX_3D, 0, 0]],
        [v(1, 1, RGBA8), [RGBA8_TL, TEX_3D, 0, 1]],
        [v(1, 1, RGBA8), [0, TEX_3D, 0, 2]],
        [v(1, 1, RGBA8), [0, TEX_3D, 1, 1]],
    ]);
});

test('a cube texture is viewed as a cube, by default or asked (test_create_shader_resource_view,'
    + ' d3d10core.c:3573-3577, 3611-3613)', ()=>{
    const cube = (/** @type {number} */ mips)=>({ mips, slices: 6, format: RGBA8,
        misc: D3D10_RESOURCE_MISC.TEXTURECUBE });
    const TEX_CUBE = 9;
    runViewTable('srv', 'CreateShaderResourceView', D3D10_BIND.SHADER_RESOURCE, [
        [cube(1), null, [RGBA8, TEX_CUBE, 0, 1]],
        [cube(2), null, [RGBA8, TEX_CUBE, 0, 2]],
        [cube(2), [0, TEX_CUBE, 0, ALL], [RGBA8, TEX_CUBE, 0, 2]],
        [cube(2), [0, TEX_CUBE, 0, 1], [RGBA8, TEX_CUBE, 0, 1]],
        [cube(2), [0, TEX_CUBE, 1, 1], [RGBA8, TEX_CUBE, 1, 1]],
        // Its six faces are still a two-dimensional array.
        [cube(1), [0, 5, 0, 1, 2, 4], [RGBA8, 5, 0, 1, 2, 4]],
    ], [
        [cube(1), [RGBA8, TEX_CUBE, 0, 0]],
        [cube(1), [RGBA8, TEX_CUBE, 0, 2]],
        [cube(1), [RGBA8, TEX_CUBE, 1, 1]],
        [{ mips: 1, slices: 1, format: RGBA8, volume: true }, [RGBA8, TEX_CUBE, 0, 1]],
        [{ mips: 1, slices: 6, format: RGBA8 }, [RGBA8, TEX_CUBE, 0, 1]],
    ]);
});

test('a buffer view\'s first element and element count come through the seam, are held to the'
    + ' buffer, and read back (test_create_shader_resource_view, d3d10core.c:3658-3666;'
    + ' test_buffer_srv, 15039-15044)', ()=>{
    const h = seamed();
    const { device } = h.createDeviceAndSwapChain();
    /** @param {number} bytes */
    const buffer = bytes=>{
        const out = h.box.place([0]);
        assert.equal(h.device(device, 'CreateBuffer', [h.box.place([bytes, D3D10_USAGE.DEFAULT,
            D3D10_BIND.SHADER_RESOURCE, 0, 0]), 0, out]), S_OK);
        return h.box.memory.readU32(out);
    };
    /**
     * @param {number} resource @param {number} format
     * @param {number} first @param {number} count
     */
    const view = (resource, format, first, count)=>{
        const out = h.box.place([0xdeadbeef]);
        const hr = h.device(device, 'CreateShaderResourceView', [resource,
            h.box.place([format, 1, first, count, STALE, STALE]), out]);
        return { hr, view: h.box.memory.readU32(out) };
    };
    const RGBA32F = DXGI_FORMAT.R32G32B32A32_FLOAT;
    const kilobyte = buffer(1024);
    const whole = view(kilobyte, RGBA32F, 0, 64);
    assert.equal(whole.hr, S_OK, 'sixty-four sixteen-byte elements fill a kilobyte');
    const part = view(kilobyte, RGBA32F, 4, 8);
    assert.equal(part.hr, S_OK);
    assert.deepEqual(reportedViewDesc(h, 'srv', part.view).words, [RGBA32F, 1, 4, 8, 0, 0]);
    assert.deepEqual(/** @type {any} */ (h.publisher.objectAt(part.view)).range, null,
        'a buffer view has no levels or slices');
    /** @type {{ desc?: any }} */
    const held = {};
    /** @type {any} */ (h.publisher.objectAt(part.view)).GetDesc(held);
    assert.deepEqual([held.desc.ElementOffset, held.desc.ElementWidth], [4, 8],
        'what the renderer hands the shader as the view\'s first element and count');

    // Wine's offset buffers: the range ends exactly at the buffer's end.
    assert.equal(view(buffer(320), DXGI_FORMAT.R8G8B8A8_UNORM, 64, 16).hr, S_OK);
    assert.equal(view(buffer(260), DXGI_FORMAT.R8_UNORM, 256, 4).hr, S_OK);
    // One element past it, or none at all, is no view.
    for (const [first, count] of [[60, 8], [0, 65], [64, 1], [0, 0]])
    {
        const refused = view(kilobyte, RGBA32F, first, count);
        assert.deepEqual([refused.hr, refused.view], [E_INVALIDARG, 0], `${first}+${count}`);
    }
});

test('an input layout of no elements is made through the seam from a NULL array', ()=>{
    const h = seamed();
    const { device } = h.createDeviceAndSwapChain();
    const bytecode = assemble({
        kind: SHADER_KIND.VERTEX,
        inputs: [{ name: 'SV_VERTEXID', systemValue: SYSTEM_VALUE.VERTEX_ID, register: 0,
            componentType: COMPONENT_TYPE.UINT }],
        outputs: [{ name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        instructions: [dclInputSiv(input(0), SYSTEM_VALUE.VERTEX_ID),
            dclOutputSiv(o(0), SYSTEM_VALUE.POSITION), utof(o(0), input(0)), ret()],
    });
    const out = h.box.place([0xdeadbeef]);
    assert.equal(h.device(device, 'CreateInputLayout', [0, 0, h.box.placeBytes(bytecode),
        bytecode.length, out]), S_OK);
    const layout = h.box.memory.readU32(out);
    assert.notEqual(layout, 0);
    assert.equal(h.box.call(layout, 2), 0);
});

test('the libraries hand DXGI the window\'s client area for a swap chain asked for at zero',
    ()=>{
        const box = machine();
        const gpu = createFakeDevice();
        const backend = createBackend({ device: gpu.device, queue: gpu.queue,
            presentTo: ()=>{}, now: ()=>0 });
        /** @type {number[]} */
        const measured = [];
        const { libraries } = createGraphicsLibraries({
            graphics: {
                create: (/** @type {string} */ name)=>(name === 'd3d10'
                    ? { backend, createSampler: (/** @type {any} */ descriptor)=>({ descriptor }),
                        createTexture: gpu.device.createTexture }
                    : null),
                available: ()=>false,
            },
            only: ['D3D10.dll', 'DXGI.dll'],
            memory: box.services,
            publishInterface: box.publishInterface,
            unpublishInterface: box.unpublishInterface,
            allocate: box.allocate,
            screen: ()=>({ width: 1920, height: 1080, bitsPerPixel: 32 }),
            windowClientSize: (/** @type {number} */ window)=>{
                measured.push(window);
                return window === 0x1234 ? { width: 300, height: 200 } : null;
            },
        });
        const descAt = box.allocate(DXGI_SWAP_CHAIN_DESC.SIZE);
        writeSwapChainDesc(box.services, descAt, {
            bufferDesc: { width: 0, height: 0, refreshNumerator: 60, refreshDenominator: 1,
                format: DXGI_FORMAT.R8G8B8A8_UNORM, scanlineOrdering: 0, scaling: 0 },
            sampleDesc: { count: 1, quality: 0 },
            bufferUsage: DXGI_USAGE.RENDER_TARGET_OUTPUT,
            bufferCount: 1,
            outputWindow: 0x1234,
            windowed: true,
            swapEffect: DXGI_SWAP_EFFECT.DISCARD,
            flags: 0,
        });
        const chainAt = box.place([0]);
        const deviceAt = box.place([0]);
        assert.equal(libraries['D3D10.dll'].D3D10CreateDeviceAndSwapChain.handler([0,
            D3D10_DRIVER_TYPE.HARDWARE, 0, 0, D3D10_SDK_VERSION, descAt, chainAt, deviceAt]) >>> 0,
        S_OK);
        const out = box.allocate(DXGI_SWAP_CHAIN_DESC.SIZE);
        assert.equal(box.call(box.memory.readU32(chainAt), slot(IDXGISWAPCHAIN_SLOTS, 'GetDesc'),
            [out]), S_OK);
        assert.deepEqual([box.memory.readU32(out), box.memory.readU32(out + 4)], [300, 200],
            'the window\'s client area, not the 1920 by 1080 display');
        assert.deepEqual(measured, [0x1234]);
    });

test('multisample quality levels through the seam: a count out of range writes its zero and'
    + ' fails, an unknown format writes nothing (d3d10core.c:10638-10679)', ()=>{
    const h = seamed();
    const { device } = h.createDeviceAndSwapChain();
    /** @param {number} format @param {number} count */
    const check = (format, count)=>{
        const out = h.box.place([0xdeadbeef]);
        const hr = h.device(device, 'CheckMultisampleQualityLevels', [format, count, out]);
        return [hr, h.box.memory.readU32(out)];
    };
    assert.deepEqual(check(DXGI_FORMAT.R8G8B8A8_UNORM, 4), [S_OK, 1]);
    assert.deepEqual(check(DXGI_FORMAT.R8G8B8A8_UNORM, 33), [0x80004005, 0], 'E_FAIL');
    assert.deepEqual(check(65536, 2), [E_INVALIDARG, 0xdeadbeef]);
    assert.equal(h.device(device, 'CheckMultisampleQualityLevels',
        [DXGI_FORMAT.R8G8B8A8_UNORM, 2, 0]), E_INVALIDARG);
});
