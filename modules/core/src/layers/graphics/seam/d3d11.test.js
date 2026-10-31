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
    ID3D11DEVICECHILD_SLOTS, ID3D11DEVICECONTEXT_SLOTS, ID3D11DEVICE_SLOTS,
    ID3D11RESOURCEDESC_SLOTS, ID3D11VIEWDESC_SLOTS, miscFlagsIn, miscFlagsOut,
} from './d3d11.js';
import {
    D3D10_BIND, D3D10_USAGE, D3D_FEATURE_LEVEL, DXGI_FORMAT, E_INVALIDARG, IID, S_FALSE, S_OK,
} from '../d3d10/constants.js';
import { createDirect3D10 } from '../d3d10/root.js';
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

/** A flat address space, the bridge's publisher, and the seam over a recording GPU. */
function seamed(){
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
        root: factoryOptions=>createDirect3D10({
            factoryOptions, backend,
            createSampler: descriptor=>({ kind: 'sampler', descriptor }),
            createTexture: gpu.device.createTexture,
            divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
        }),
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
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
    /** @param {number} pointer @param {number} index @param {number[]} args */
    const call = (pointer, index, args = [])=>{
        const entry = registered.get(memory.readU32(memory.readU32(pointer) + index * 4));
        assert.ok(entry, `slot ${index} has an implementation`);
        return entry.fn.handler([pointer, ...args]) >>> 0;
    };
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
    return { memory, place, call, query, create, divergences, seam };
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
    s.call(context1, swap, [s.memory.readU32(previousAt), s.place([0])]);
    s.call(context, slot(ID3D11DEVICECONTEXT_SLOTS, 'VSGetSamplers'), [0, 1, got]);
    assert.equal(s.memory.readU32(got), sampler, 'the bindings come back with their state');
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
