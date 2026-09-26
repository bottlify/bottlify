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
    ID3D10BUFFER_SLOTS, ID3D10DEVICE_SLOTS, ID3D10QUERY_SLOTS, ID3D10TEXTURE_SLOTS,
    IDXGIADAPTER_SLOTS,
    IDXGIFACTORY_SLOTS, IDXGISWAPCHAIN_SLOTS, createDirect3D10Seam,
} from './d3d10.js';
import {
    D3D10_BIND, D3D10_CPU_ACCESS, D3D10_DRIVER_TYPE, D3D10_MAP, D3D10_PRIMITIVE_TOPOLOGY,
    D3D10_QUERY, D3D10_SDK_VERSION, D3D10_USAGE, DXGI_ERROR_INVALID_CALL, DXGI_FORMAT,
    DXGI_SWAP_EFFECT, DXGI_USAGE, E_INVALIDARG, IID, S_OK,
} from '../d3d10/constants.js';
import { DXGI_SWAP_CHAIN_DESC, writeSwapChainDesc } from '../d3d10/structs.js';
import { passThroughVertexShader, solidPixelShader } from '../d3d10/shader-fixtures.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

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
        /** @param {number} pointer @param {number} index @param {number[]} args */
        call(pointer, index, args = []){
            const table = memory.readU32(pointer);
            const entry = registered.get(memory.readU32(table + index * 4));
            assert.ok(entry, `slot ${index} has an implementation`);
            return entry.fn.handler([pointer, ...args]) >>> 0;
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
    const publisher = createPublisher({ publishInterface: box.publishInterface });
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

test('what this build cannot do says so in the slot rather than in a crash', ()=>{
    const h = seamed();
    const { device, swapChain } = h.createDeviceAndSwapChain();
    const out = h.box.place([0xdeadbeef]);
    assert.equal(h.device(device, 'OpenSharedResource',
        [1, h.box.placeGuid(IID.ID3D10Texture2D), out]), E_NOTIMPL);
    assert.equal(h.box.memory.readU32(out), 0);
    const outAndBeyond = h.box.place([0xdeadbeef, 0xfeedface]);
    assert.equal(h.device(device, 'CreateGeometryShaderWithStreamOutput',
        [0, 0, 0, 0, 32, outAndBeyond, outAndBeyond + 4]), E_NOTIMPL);
    assert.equal(h.box.memory.readU32(outAndBeyond), 0, 'the sixth argument is the out');
    assert.equal(h.box.memory.readU32(outAndBeyond + 4), 0xfeedface,
        'the caller\'s next stack word is not an argument');
    assert.equal(h.swapChain(swapChain, 'GetContainingOutput', [out]), 0x887a0022);
    assert.equal(h.box.memory.readU32(out), 0);
    const modes = h.box.place([7]);
    assert.equal(h.box.call(h.box.memory.readU32(out) || swapChain,
        slot(IDXGISWAPCHAIN_SLOTS, 'ResizeTarget'), [modes]), S_OK);
    assert.equal(h.device(device, 'ResolveSubresource', [0, 0, 0, 0, 0]), 0);
    assert.ok(h.divergences.some(line=>line.includes('ResolveSubresource')));
});
