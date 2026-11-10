/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D 11 seam, driven as a guest drives it: through the bridge's
 * vtable publisher, by slot number, over a flat buffer standing in for guest
 * memory. What is checked is translation and the object model's identity --
 * the device, the renderer and Wine's conformance tests check the rest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVtables } from '../../bridge/internal/vtable.js';
import { createPublisher } from './com.js';
import { createDirect3D10Seam } from './d3d10.js';
import {
    ID3D11DEVICE1_SLOTS, ID3D11DEVICECHILD_SLOTS, ID3D11DEVICECONTEXT_SLOTS, ID3D11DEVICE_SLOTS,
    ID3D11RESOURCEDESC_SLOTS, ID3D11VIEWDESC_SLOTS, miscFlagsIn, miscFlagsOut,
} from './d3d11.js';
import {
    IDXGIDEVICE_SLOTS, IDXGIFACTORY2_SLOTS, IDXGIKEYEDMUTEX_SLOTS, IDXGIRESOURCE1_SLOTS,
    IDXGIRESOURCE_SLOTS,
} from './d3d10.js';
import {
    D3D10_BIND, D3D10_USAGE, D3D_FEATURE_LEVEL, DXGI_FORMAT, E_INVALIDARG, IID, S_FALSE, S_OK,
} from '../d3d10/constants.js';
import { createDirect3D10 } from '../d3d10/root.js';
import { playedAtOnce } from '../remote/direct3d.js';
import { playedDirect3D10, recordedDirect3D10 } from '../remote/d3d10.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/** @param {[string, number][]} slots @param {string} name */
const slot = (slots, name)=>{
    const index = slots.findIndex(([entry])=>entry === name);
    assert.ok(index >= 0, `${name} is a slot`);
    return 3 + index;
};

/** IUnknown's: QueryInterface, AddRef, Release. */
const QUERY_INTERFACE = 0;
const ADD_REF = 1;
const RELEASE = 2;

/**
 * A flat address space, the bridge's publisher, and the seam over a recording
 * GPU: the device drawn here, or recorded and played elsewhere.
 *
 * @param {{ elsewhere?: boolean, pointerSize?: 4 | 8,
 *     sharedHandles?: { open: (key: number) => number,
 *     resolve: (handle: number) => number | null } }} [options]
 */
function seamed(options = {}){
    const bytes = new Uint8Array(4 << 20);
    let next = 0x100;
    /** @param {number} size */
    const allocate = size=>{
        const at = next;
        next += (size + 16) & ~15;
        return at;
    };
    const memory = {
        /** @param {number} address @param {number} length */
        readBytes: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} value */
        writeBytes: (address, value)=>{
            bytes.set(value, address);
        },
        /** @param {number} address */
        readU32: address=>new DataView(bytes.buffer).getUint32(address, true),
        /** @param {number} address @param {number} value */
        writeU32: (address, value)=>{
            new DataView(bytes.buffer).setUint32(address, value >>> 0, true);
        },
    };
    /** @type {Map<number, any>} */
    const registered = new Map();
    let nextTrap = 1;
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
    const publisher = createPublisher({
        publishInterface: (object, id)=>vtables.publish(object, id),
        unpublishInterface: (object, id)=>vtables.unpublish(object, id),
    });
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    /** @type {string[]} */
    const divergences = [];
    const seam = createDirect3D10Seam({
        publisher,
        memory: { readMemory: memory.readBytes, writeMemory: memory.writeBytes },
        allocate,
        root: factoryOptions=>{
            const drawing = {
                factoryOptions, backend,
                createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler',
                    descriptor }),
                createTexture: gpu.device.createTexture,
                divergence: (/** @type {string} */ api, /** @type {string} */ detail)=>
                    divergences.push(`${api}: ${detail}`),
            };
            const guest = { allocate, free: ()=>{}, readMemory: memory.readBytes,
                writeMemory: memory.writeBytes };
            return options.elsewhere
                ? recordedDirect3D10(createDirect3D10, { factoryOptions, guest },
                    playedAtOnce(playedDirect3D10(createDirect3D10, { ...drawing,
                        writeMemory: memory.writeBytes })))
                : createDirect3D10({ ...drawing, guest });
        },
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
        sharedHandles: options.sharedHandles,
        ...options.pointerSize ? { pointerSize: options.pointerSize } : {},
    });
    /** @param {number[]} dwords */
    const place = dwords=>{
        const at = allocate(Math.max(4, dwords.length * 4));
        dwords.forEach((dword, index)=>memory.writeU32(at + index * 4, dword));
        return at;
    };
    /** @param {string} guid */
    const placeGuid = guid=>{
        const hex = guid.replace(/[{}-]/g, '');
        const at = allocate(16);
        const view = new DataView(bytes.buffer);
        view.setUint32(at, parseInt(hex.slice(0, 8), 16), true);
        view.setUint16(at + 4, parseInt(hex.slice(8, 12), 16), true);
        view.setUint16(at + 6, parseInt(hex.slice(12, 16), 16), true);
        for (let index = 0; index < 8; index++)
        {
            bytes[at + 8 + index] = parseInt(hex.slice(16 + index * 2, 18 + index * 2), 16);
        }
        return at;
    };
    /**
     * The call's answer as the handler gives it: a number, or a promise of one
     * where the call waits.
     *
     * @param {number} pointer @param {number} index @param {number[]} args
     * @returns {any}
     */
    const answer = (pointer, index, args = [])=>{
        const entry = registered.get(memory.readU32(memory.readU32(pointer) + index * 4));
        assert.ok(entry, `slot ${index} has an implementation`);
        return entry.fn.handler([pointer, ...args]);
    };
    /** @param {number} pointer @param {number} index @param {number[]} args */
    const call = (pointer, index, args = [])=>answer(pointer, index, args) >>> 0;
    /** @param {number} pointer @param {string} iid @returns {number} the pointer, or 0 */
    const query = (pointer, iid)=>{
        const out = place([0]);
        call(pointer, QUERY_INTERFACE, [placeGuid(iid), out]);
        return memory.readU32(out);
    };
    const d3d11 = seam.libraries['D3D11.dll'];
    /**
     * D3D11CreateDevice with the default levels and what the caller asks for back.
     *
     * @param {{ device?: boolean, context?: boolean }} [wanted]
     */
    const create = (wanted = { device: true, context: true })=>{
        const deviceAt = wanted.device ? place([0xdeadbeef]) : 0;
        const contextAt = wanted.context ? place([0xdeadbeef]) : 0;
        const levelAt = place([0xdeadbeef]);
        const hr = d3d11.D3D11CreateDevice.handler([0, 1, 0, 0, 0, 0, 7, deviceAt, levelAt,
            contextAt]) >>> 0;
        return {
            hr, level: memory.readU32(levelAt),
            device: deviceAt ? memory.readU32(deviceAt) : 0,
            context: contextAt ? memory.readU32(contextAt) : 0,
        };
    };
    return { memory, place, placeGuid, call, answer, query, create, divergences, seam };
}

test('D3D11CreateDevice answers S_FALSE asked for nothing, and makes a device of level 11.0'
    + ' with its immediate context', ()=>{
    const s = seamed();
    const none = s.create({});
    assert.equal(none.hr, S_FALSE);
    assert.equal(none.level, D3D_FEATURE_LEVEL.LEVEL_11_0);
    const made = s.create();
    assert.equal(made.hr, S_OK);
    assert.ok(made.device !== 0 && made.context !== 0);
    assert.equal(s.call(made.device, slot(ID3D11DEVICE_SLOTS, 'GetFeatureLevel')),
        D3D_FEATURE_LEVEL.LEVEL_11_0);
    // The device is Direct3D 11's alone; its context is the one it hands out.
    assert.equal(s.query(made.device, IID.ID3D10Device), 0);
    assert.notEqual(s.query(made.device, IID.IDXGIDevice), 0);
    const out = s.place([0]);
    s.call(made.device, slot(ID3D11DEVICE_SLOTS, 'GetImmediateContext'), [out]);
    assert.equal(s.memory.readU32(out), made.context, 'one immediate context');
});

test('a context alone asked for holds its device, which goes with its last release', ()=>{
    const s = seamed();
    const made = s.create({ context: true });
    assert.equal(made.hr, S_OK);
    const out = s.place([0]);
    s.call(made.context, slot(ID3D11DEVICECHILD_SLOTS, 'GetDevice'), [out]);
    const device = s.memory.readU32(out);
    assert.equal(s.call(device, RELEASE), 1, 'the context holds the device');
    assert.equal(s.call(made.context, RELEASE), 0);
});

test('a structured buffer is Direct3D 11\'s alone, and keeps its stride; a plain one answers'
    + ' Direct3D 10 too', ()=>{
    const s = seamed();
    const { device } = s.create();
    const createBuffer = (/** @type {number} */ misc, /** @type {number} */ stride)=>{
        const out = s.place([0]);
        const hr = s.call(device, slot(ID3D11DEVICE_SLOTS, 'CreateBuffer'), [s.place([64,
            D3D10_USAGE.DEFAULT, D3D10_BIND.SHADER_RESOURCE, 0, misc, stride]), 0, out]);
        return { hr, buffer: s.memory.readU32(out) };
    };
    const structured = createBuffer(0x40, 16);
    assert.equal(structured.hr, S_OK);
    assert.equal(s.query(structured.buffer, IID.ID3D10Buffer), 0);
    const desc = s.place(new Array(6).fill(0));
    s.call(structured.buffer, slot(ID3D11RESOURCEDESC_SLOTS, 'GetDesc'), [desc]);
    assert.deepEqual([4, 5].map(index=>s.memory.readU32(desc + index * 4)), [0x40, 16]);
    assert.equal(createBuffer(0x40, 6).hr, E_INVALIDARG, 'a stride of whole words');
    const plain = createBuffer(0, 513);
    assert.notEqual(s.query(plain.buffer, IID.ID3D10Buffer), 0);
    s.call(plain.buffer, slot(ID3D11RESOURCEDESC_SLOTS, 'GetDesc'), [desc]);
    assert.equal(s.memory.readU32(desc + 20), 0, 'no structures, no stride');
});

test('what a context binds outlives the program\'s last reference, and comes back as itself',
    ()=>{
        const s = seamed();
        const { device, context } = s.create();
        const texture = s.place([0]);
        assert.equal(s.call(device, slot(ID3D11DEVICE_SLOTS, 'CreateTexture2D'), [s.place([4, 4,
            1, 1, DXGI_FORMAT.R8G8B8A8_UNORM, 1, 0, D3D10_USAGE.DEFAULT,
            D3D10_BIND.SHADER_RESOURCE, 0, 0]), 0, texture]), S_OK);
        const out = s.place([0]);
        assert.equal(s.call(device, slot(ID3D11DEVICE_SLOTS, 'CreateShaderResourceView'),
            [s.memory.readU32(texture), 0, out]), S_OK);
        const view = s.memory.readU32(out);
        s.call(s.memory.readU32(texture), RELEASE);
        s.call(context, slot(ID3D11DEVICECONTEXT_SLOTS, 'PSSetShaderResources'),
            [0, 1, s.place([view])]);
        assert.equal(s.call(view, RELEASE), 0);
        const got = s.place([0]);
        s.call(context, slot(ID3D11DEVICECONTEXT_SLOTS, 'PSGetShaderResources'), [0, 1, got]);
        assert.equal(s.memory.readU32(got), view, 'the same view, at the same address');
        assert.equal(s.call(view, RELEASE), 0);
        void ID3D11VIEWDESC_SLOTS;
        void ADD_REF;
    });

test('Direct3D 11\'s misc flags are kept in Direct3D 10\'s numbers where both have them',
    ()=>{
        // Keyed mutex and GDI moved up a bit in 11; the rest are 11's own.
        const kept = miscFlagsIn(0x100 | 0x200 | 0x40 | 0x4);
        assert.deepEqual(kept, { MiscFlags: 0x10 | 0x20 | 0x4, MiscFlags11: 0x40 });
        assert.equal(miscFlagsOut(kept), 0x100 | 0x200 | 0x40 | 0x4);
    });

test('a context state swapped on holds the pipeline the context had, and gives it back', ()=>{
    const s = seamed();
    const { device, context } = s.create();
    const samplerAt = s.place([0]);
    assert.equal(s.call(device, slot(ID3D11DEVICE_SLOTS, 'CreateSamplerState'), [s.place([0x15,
        1, 1, 1, 0, 0, 8, 0, 0, 0, 0, 0, 0x7f7fffff]), samplerAt]), S_OK);
    const sampler = s.memory.readU32(samplerAt);
    s.call(context, slot(ID3D11DEVICECONTEXT_SLOTS, 'VSSetSamplers'), [0, 1, samplerAt]);
    // CreateDeviceContextState(flags, levels, count, sdk, emulated, level, out)
    const stateAt = s.place([0]);
    const device1 = s.query(device, IID.ID3D11Device1);
    const base = ID3D11DEVICE_SLOTS.length + 3;
    assert.equal(s.call(device1, base + 4, [0, s.place([0xa000]), 1, 7, placeGuidOf(s,
        IID.ID3D10Device), 0, stateAt]), S_OK);
    const context1 = s.query(context, IID.ID3D11DeviceContext1);
    const swap = ID3D11DEVICECONTEXT_SLOTS.length + 3 + 16;
    const previousAt = s.place([0]);
    s.call(context1, swap, [s.memory.readU32(stateAt), previousAt]);
    assert.notEqual(s.memory.readU32(previousAt), 0);
    const got = s.place([0]);
    s.call(context, slot(ID3D11DEVICECONTEXT_SLOTS, 'VSGetSamplers'), [0, 1, got]);
    assert.equal(s.memory.readU32(got), 0, 'Direct3D 10\'s state sees no Direct3D 11 binding');
    const untouched = s.place([0xdeadbeef]);
    s.call(context, slot(ID3D11DEVICECONTEXT_SLOTS, 'PSGetSamplers'), [0, 1, untouched]);
    assert.equal(s.memory.readU32(untouched), 0xdeadbeef,
        'but for the pixel stage\'s samplers, which Windows leaves unwritten');
    s.call(context1, swap, [s.memory.readU32(previousAt), s.place([0])]);
    s.call(context, slot(ID3D11DEVICECONTEXT_SLOTS, 'VSGetSamplers'), [0, 1, got]);
    assert.equal(s.memory.readU32(got), sampler, 'the bindings come back with their state');
});

test('a deferred context swaps no context state and answers none before it', ()=>{
    // Wine's test_deferred_context_swap_state; the call threw in the host.
    const s = seamed();
    const { device } = s.create();
    const deferredOut = s.place([0]);
    assert.equal(s.call(device, slot(ID3D11DEVICE_SLOTS, 'CreateDeferredContext'),
        [0, deferredOut]), S_OK);
    const deferred = s.query(s.memory.readU32(deferredOut), IID.ID3D11DeviceContext1);
    const stateAt = s.place([0]);
    const device1 = s.query(device, IID.ID3D11Device1);
    const base = ID3D11DEVICE_SLOTS.length + 3;
    assert.equal(s.call(device1, base + 4, [0, s.place([0xb000]), 1, 7, placeGuidOf(s,
        IID.ID3D11Device1), 0, stateAt]), S_OK);
    const swap = ID3D11DEVICECONTEXT_SLOTS.length + 3 + 16;
    const previousAt = s.place([0xdeadbeef]);
    s.call(deferred, swap, [0, previousAt]);
    assert.equal(s.memory.readU32(previousAt), 0, 'none, swapped for none');
    s.memory.writeU32(previousAt, 0xdeadbeef);
    s.call(deferred, swap, [s.memory.readU32(stateAt), previousAt]);
    assert.equal(s.memory.readU32(previousAt), 0, 'none, swapped for a state');
});

/** @param {ReturnType<typeof seamed>} s @param {string} iid */
function placeGuidOf(s, iid){
    const hex = iid.replace(/[{}-]/g, '');
    const words = [parseInt(hex.slice(0, 8), 16),
        parseInt(hex.slice(12, 16) + hex.slice(8, 12), 16),
        ...[16, 24].map(at=>parseInt((hex.slice(at, at + 8).match(/../g) ?? []).reverse()
            .join(''), 16))];
    return s.place(words);
}

for (const elsewhere of [false, true])
{
    test(`a staging texture copied from a cleared target maps to the cleared colour, drawn`
        + ` ${elsewhere ? 'elsewhere' : 'here'}`, async()=>{
        const s = seamed({ elsewhere });
        const { device, context } = s.create();
        const textureAt = s.place([0]);
        // D3D11_TEXTURE2D_DESC: 4 by 4, one level, one slice, RGBA8, one sample.
        const desc = (/** @type {number} */ usage, /** @type {number} */ bind,
            /** @type {number} */ cpu)=>s.place([4, 4, 1, 1, DXGI_FORMAT.R8G8B8A8_UNORM, 1, 0,
            usage, bind, cpu, 0]);
        assert.equal(s.call(device, slot(ID3D11DEVICE_SLOTS, 'CreateTexture2D'),
            [desc(D3D10_USAGE.DEFAULT, D3D10_BIND.RENDER_TARGET, 0), 0, textureAt]), S_OK);
        const stagingAt = s.place([0]);
        assert.equal(s.call(device, slot(ID3D11DEVICE_SLOTS, 'CreateTexture2D'),
            [desc(D3D10_USAGE.STAGING, 0, 0x20000), 0, stagingAt]), S_OK);
        const viewAt = s.place([0]);
        assert.equal(s.call(device, slot(ID3D11DEVICE_SLOTS, 'CreateRenderTargetView'),
            [s.memory.readU32(textureAt), 0, viewAt]), S_OK);
        const red = s.place([1, 0, 0, 1].map(value=>new Uint32Array(
            new Float32Array([value]).buffer)[0]));
        s.call(context, slot(ID3D11DEVICECONTEXT_SLOTS, 'ClearRenderTargetView'),
            [s.memory.readU32(viewAt), red]);
        s.call(context, slot(ID3D11DEVICECONTEXT_SLOTS, 'CopyResource'),
            [s.memory.readU32(stagingAt), s.memory.readU32(textureAt)]);
        const mappedAt = s.place([0, 0, 0]);
        // D3D11_MAP_READ
        const hr = await s.answer(context, slot(ID3D11DEVICECONTEXT_SLOTS, 'Map'),
            [s.memory.readU32(stagingAt), 0, 1, 0, mappedAt]);
        assert.equal(hr >>> 0, S_OK);
        const at = s.memory.readU32(mappedAt);
        assert.notEqual(at, 0, 'the map wrote where the bytes are');
        assert.deepEqual([...s.memory.readBytes(at, 4)], [255, 0, 0, 255]);
        assert.equal(s.memory.readU32(mappedAt + 4), 16, 'four texels a row');
    });
}

test('a 64-bit process lays its initial data and its map out whole: pointers of eight bytes',
    async()=>{
        const s = seamed({ pointerSize: 8 });
        const { device, context } = s.create();
        // D3D11_SUBRESOURCE_DATA at 64 bits: pSysMem a quadword, the pitches past it.
        const words = s.place([10, 11, 12, 13]);
        const initial = s.place([words, 0, 0, 0]);
        const out = s.place([0xcccccccc, 0xcccccccc]);
        assert.equal(s.call(device, slot(ID3D11DEVICE_SLOTS, 'CreateBuffer'),
            [s.place([16, D3D10_USAGE.STAGING, 0, 0x20000, 0, 0]), initial, out]), S_OK);
        assert.equal(s.memory.readU32(out + 4), 0, 'the interface whole, its high half zero');
        // D3D11_MAPPED_SUBRESOURCE at 64 bits: pData, then RowPitch and DepthPitch at 8.
        const mapped = s.place([0xdeadbeef, 0xdeadbeef, 0xabab, 0xcdcd]);
        assert.equal(await s.answer(context, slot(ID3D11DEVICECONTEXT_SLOTS, 'Map'),
            [s.memory.readU32(out), 0, 1, 0, mapped]) >>> 0, S_OK);
        const at = s.memory.readU32(mapped);
        assert.equal(s.memory.readU32(mapped + 4), 0, 'pData whole');
        assert.deepEqual([8, 12].map(offset=>s.memory.readU32(mapped + offset)), [16, 16]);
        assert.deepEqual([0, 1, 2, 3].map(index=>s.memory.readU32(at + 4 * index)),
            [10, 11, 12, 13], 'the initial data read from its quadword pointer');
    });

test('a deferred map leaves the buffer as it was until its list plays, and refuses what it'
    + ' must (test_deferred_context_map, d3d11.c:33978)', async()=>{
    const s = seamed();
    const { device, context } = s.create();
    /** @param {number} usage @param {number} bind @param {number} cpu @param {number} [data] */
    const createBuffer = (usage, bind, cpu, data = 0)=>{
        const out = s.place([0]);
        assert.equal(s.call(device, slot(ID3D11DEVICE_SLOTS, 'CreateBuffer'),
            [s.place([16, usage, bind, cpu, 0, 0]), data, out]), S_OK);
        return s.memory.readU32(out);
    };
    const initial = s.place([s.place([10, 11, 12, 13]), 0, 0]);
    const dynamic = createBuffer(D3D10_USAGE.DYNAMIC, D3D10_BIND.VERTEX_BUFFER, 0x10000, initial);
    const staging = createBuffer(D3D10_USAGE.STAGING, 0, 0x20000);
    const deferredOut = s.place([0]);
    assert.equal(s.call(device, slot(ID3D11DEVICE_SLOTS, 'CreateDeferredContext'),
        [0, deferredOut]), S_OK);
    const deferred = s.memory.readU32(deferredOut);
    const mapSlot = slot(ID3D11DEVICECONTEXT_SLOTS, 'Map');
    const unmapSlot = slot(ID3D11DEVICECONTEXT_SLOTS, 'Unmap');
    const mapped = s.place([0xdeadbeef, 0xabab, 0xcdcd]);
    assert.equal(s.call(deferred, mapSlot, [dynamic, 0, 1, 0, mapped]), E_INVALIDARG);
    assert.deepEqual([0, 4, 8].map(at=>s.memory.readU32(mapped + at)), [0, 0xabab, 0xcdcd],
        'a refused map hands out no pointer and leaves the pitches');
    assert.equal(s.call(deferred, mapSlot, [dynamic, 0, 5, 0, mapped]) >>> 0, 0x887c0004,
        'NO_OVERWRITE before a discard on this context');
    assert.equal(s.call(deferred, mapSlot, [dynamic, 0, 4, 0, mapped]), S_OK);
    const data = s.memory.readU32(mapped);
    [2, 4, 6, 8].forEach((word, index)=>s.memory.writeU32(data + 4 * index, word));
    s.call(deferred, unmapSlot, [dynamic, 0]);
    assert.equal(s.call(deferred, mapSlot, [dynamic, 0, 4, 0, mapped]), S_OK, 'and again');
    const again = s.memory.readU32(mapped);
    [3, 6, 9, 12].forEach((word, index)=>s.memory.writeU32(again + 4 * index, word));
    s.call(deferred, unmapSlot, [dynamic, 0]);
    const listOut = s.place([0]);
    assert.equal(s.call(deferred, slot(ID3D11DEVICECONTEXT_SLOTS, 'FinishCommandList'),
        [0, listOut]), S_OK);
    const read = async()=>{
        s.call(context, slot(ID3D11DEVICECONTEXT_SLOTS, 'CopyResource'), [staging, dynamic]);
        assert.equal(await s.answer(context, mapSlot, [staging, 0, 1, 0, mapped]) >>> 0, S_OK);
        const at = s.memory.readU32(mapped);
        const words = [0, 1, 2, 3].map(index=>s.memory.readU32(at + 4 * index));
        s.call(context, unmapSlot, [staging, 0]);
        return words;
    };
    assert.deepEqual(await read(), [10, 11, 12, 13], 'before the list plays');
    s.call(context, slot(ID3D11DEVICECONTEXT_SLOTS, 'ExecuteCommandList'),
        [s.memory.readU32(listOut), 0]);
    assert.deepEqual(await read(), [3, 6, 9, 12], 'after');
    assert.equal(s.call(deferred, mapSlot, [dynamic, 0, 5, 0, mapped]) >>> 0, 0x887c0004,
        'a list ends its maps: NO_OVERWRITE again before a discard');
});

test('a buffer mapped on a deferred context is written where its command list plays', async()=>{
    // WRITE_DISCARD then WRITE_NO_OVERWRITE on a deferred context, the
    // documented way to fill a dynamic buffer there; it threw in the host.
    const s = seamed();
    const { device, context } = s.create();
    /** @param {number} usage @param {number} bind @param {number} cpu */
    const createBuffer = (usage, bind, cpu)=>{
        const out = s.place([0]);
        assert.equal(s.call(device, slot(ID3D11DEVICE_SLOTS, 'CreateBuffer'),
            [s.place([16, usage, bind, cpu, 0, 0]), 0, out]), S_OK);
        return s.memory.readU32(out);
    };
    // DYNAMIC, a vertex buffer, CPU write; and a STAGING copy to read it back.
    const dynamic = createBuffer(D3D10_USAGE.DYNAMIC, D3D10_BIND.VERTEX_BUFFER, 0x10000);
    const staging = createBuffer(D3D10_USAGE.STAGING, 0, 0x20000);
    const deferredOut = s.place([0]);
    assert.equal(s.call(device, slot(ID3D11DEVICE_SLOTS, 'CreateDeferredContext'),
        [0, deferredOut]), S_OK);
    const deferred = s.memory.readU32(deferredOut);
    const mapSlot = slot(ID3D11DEVICECONTEXT_SLOTS, 'Map');
    const unmapSlot = slot(ID3D11DEVICECONTEXT_SLOTS, 'Unmap');
    const mapped = s.place([0, 0, 0]);
    assert.equal(s.call(deferred, mapSlot, [dynamic, 0, 4, 0, mapped]), S_OK, 'WRITE_DISCARD');
    const data = s.memory.readU32(mapped);
    assert.notEqual(data, 0);
    assert.equal(s.memory.readU32(mapped + 4), 16, 'the row pitch, the buffer\'s width');
    [1, 2, 3, 4].forEach((word, index)=>s.memory.writeU32(data + 4 * index, word));
    s.call(deferred, unmapSlot, [dynamic, 0]);
    assert.equal(s.call(deferred, mapSlot, [dynamic, 0, 5, 0, mapped]), S_OK, 'NO_OVERWRITE');
    assert.equal(s.memory.readU32(mapped), data, 'the same memory as the discard');
    s.memory.writeU32(data + 12, 9);
    s.call(deferred, unmapSlot, [dynamic, 0]);
    assert.equal(s.call(deferred, mapSlot, [dynamic, 0, 1, 0, mapped]), E_INVALIDARG,
        'READ is not a deferred map');

    const listOut = s.place([0]);
    assert.equal(s.call(deferred, slot(ID3D11DEVICECONTEXT_SLOTS, 'FinishCommandList'),
        [0, listOut]), S_OK);
    const list = s.memory.readU32(listOut);
    s.call(context, slot(ID3D11DEVICECONTEXT_SLOTS, 'ExecuteCommandList'), [list, 0]);
    s.call(context, slot(ID3D11DEVICECONTEXT_SLOTS, 'CopyResource'), [staging, dynamic]);
    assert.equal(await s.answer(context, mapSlot, [staging, 0, 1, 0, mapped]) >>> 0, S_OK);
    const read = s.memory.readU32(mapped);
    assert.deepEqual([0, 1, 2, 3].map(index=>s.memory.readU32(read + 4 * index)), [1, 2, 3, 9]);
    s.call(context, unmapSlot, [staging, 0]);
});

/**
 * Shares made by one device and opened by another, through the seam: drawn
 * here, or recorded and played elsewhere.
 *
 * @param {boolean} elsewhere
 */
function sharedThrough(elsewhere){
    /** @type {Map<number, number>} */
    const kernel = new Map();
    const s = seamed({ elsewhere, sharedHandles: {
        /** @param {number} key */
        open: key=>{
            const handle = 0x200 + kernel.size * 4;
            kernel.set(handle, key);
            return handle;
        },
        /** @param {number} handle */
        resolve: handle=>kernel.get(handle) ?? null,
    } });
    const one = s.create().device;
    const two = s.create().device;
    /** @param {number} misc */
    const texture = misc=>{
        const out = s.place([0]);
        // D3D11_TEXTURE2D_DESC: 4x4, one level, one slice, RGBA8, one sample,
        // default usage, a shader resource.
        assert.equal(s.call(one, slot(ID3D11DEVICE_SLOTS, 'CreateTexture2D'), [s.place([4, 4,
            1, 1, DXGI_FORMAT.R8G8B8A8_UNORM, 1, 0, D3D10_USAGE.DEFAULT,
            D3D10_BIND.SHADER_RESOURCE, 0, misc]), 0, out]), S_OK);
        return s.memory.readU32(out);
    };
    /** @param {number} device @param {string} method @param {number} handle */
    const open = (device, method, handle)=>{
        const out = s.place([0xdeadbeef]);
        const hr = s.call(device, slot(ID3D11DEVICE1_SLOTS, method),
            [handle, placeGuidOf(s, IID.ID3D11Texture2D), out]);
        return { hr, pointer: s.memory.readU32(out) };
    };
    const two1 = s.query(two, IID.ID3D11Device1);

    // A legacy handle, and a keyed mutex on the texture.
    const keyed = texture(0x100);
    const resource = s.query(keyed, IID.IDXGIResource);
    const handleAt = s.place([0xdeadbeef]);
    assert.equal(s.call(resource, slot(IDXGIRESOURCE_SLOTS, 'GetSharedHandle'), [handleAt]),
        S_OK);
    const legacy = s.memory.readU32(handleAt);
    assert.ok((legacy & 0xc0000000) !== 0, 'a legacy handle');
    const opened = open(two, 'OpenSharedResource', legacy);
    assert.equal(opened.hr, S_OK);
    assert.notEqual(opened.pointer, 0);
    assert.equal(open(two1, 'OpenSharedResource1', legacy).hr, E_INVALIDARG);
    const mutex = s.query(keyed, IID.IDXGIKeyedMutex);
    const other = s.query(opened.pointer, IID.IDXGIKeyedMutex);
    assert.ok(mutex !== 0 && other !== 0);
    const acquire = slot(IDXGIKEYEDMUTEX_SLOTS, 'AcquireSync');
    const release = slot(IDXGIKEYEDMUTEX_SLOTS, 'ReleaseSync');
    assert.equal(s.call(mutex, acquire, [0, 0, 0]), S_OK, 'the key, in two words');
    assert.equal(s.call(other, acquire, [0, 0, 0]), 0x102, 'held by the other device');
    assert.equal(s.call(mutex, release, [7, 1]), S_OK);
    assert.equal(s.call(other, acquire, [7, 0, 0]), 0x102, 'a key of 64 bits');
    assert.equal(s.call(other, acquire, [7, 1, 0]), S_OK);

    // An NT handle names a texture made for one, and only through OpenSharedResource1.
    const nt = texture(0x802);
    const nt1 = s.query(nt, IID.IDXGIResource1);
    assert.equal(s.call(nt1, slot(IDXGIRESOURCE1_SLOTS, 'GetSharedHandle'), [handleAt]),
        E_INVALIDARG);
    const ntAt = s.place([0xdeadbeef]);
    assert.equal(s.call(nt1, slot(IDXGIRESOURCE1_SLOTS, 'CreateSharedHandle'),
        [0, 0x10000000, 0, ntAt]), S_OK);
    const handle = s.memory.readU32(ntAt);
    assert.equal(kernel.size, 1, 'a kernel object');
    assert.equal(open(two, 'OpenSharedResource', handle).hr, E_INVALIDARG);
    const byNt = open(two1, 'OpenSharedResource1', handle);
    assert.equal(byNt.hr, S_OK);
    assert.notEqual(byNt.pointer, 0);
    const legacy1 = s.query(keyed, IID.IDXGIResource1);
    assert.equal(s.call(legacy1, slot(IDXGIRESOURCE1_SLOTS, 'CreateSharedHandle'),
        [0, 0x10000000, 0, ntAt]), E_INVALIDARG, 'no NT handle to a legacy share');
    assert.equal(s.memory.readU32(ntAt), 0);
    assert.deepEqual(s.divergences, [], 'the played side opened the same shares');
}

test('a texture made shared is opened by another device through its handle: a legacy one, or'
    + ' an NT handle the kernel keeps (test_shared_resource, test_keyed_mutex)', ()=>{
    sharedThrough(false);
});

test('a shared texture is opened alike on a device recorded and played elsewhere', ()=>{
    sharedThrough(true);
});

for (const elsewhere of [false, true])
{
    test(`a window's swap chain from the factory its device's adapter belongs to${
        elsewhere ? ', the device drawn elsewhere' : ''}`, ()=>{
        const s = seamed({ elsewhere, pointerSize: 8 });
        const { device } = s.create();
        // As an engine finds the factory: the DXGI device, its adapter, the adapter's parent.
        const adapterAt = s.place([0, 0]);
        assert.equal(s.call(s.query(device, IID.IDXGIDevice), slot(IDXGIDEVICE_SLOTS,
            'GetAdapter'), [adapterAt]), S_OK);
        const factoryAt = s.place([0, 0]);
        assert.equal(s.call(s.memory.readU32(adapterAt), slot(IDXGIDEVICE_SLOTS, 'GetParent'),
            [s.placeGuid(IID.IDXGIFactory1), factoryAt]), S_OK);
        // DXGI_SWAP_CHAIN_DESC1: 640 by 480, B8G8R8A8, one sample, a render target, two
        // buffers, FLIP_DISCARD.
        const desc1 = s.place([640, 480, 87, 0, 1, 0, 0x20, 2, 0, 4, 0, 0]);
        const chainAt = s.place([0xcccccccc, 0xcccccccc]);
        // IDXGIFactory2's method through the IDXGIFactory1 pointer, as an engine calls it:
        // one object, its vtable the newest version's whatever it was asked as.
        assert.equal(s.call(s.memory.readU32(factoryAt), slot(IDXGIFACTORY2_SLOTS,
            'CreateSwapChainForHwnd'), [device, 0x1234, desc1, 0, 0, chainAt]), S_OK);
        assert.notEqual(s.memory.readU32(chainAt), 0, 'the swap chain handed back');
        assert.equal(s.memory.readU32(chainAt + 4), 0, 'whole');
    });
}
