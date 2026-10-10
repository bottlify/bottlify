/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderToSurface } from './render-to-surface.js';
import { deviceRig } from './device.fixture.js';

const D3DERR_INVALIDCALL = 0x8876086c;
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_D16 = 80;

/** @param {{ depth?: boolean }} [options] */
function setup(options = {}){
    const r = deviceRig();
    /** @type {number[][]} */
    const copies = [];
    const rts = createRenderToSurface(r.host, { loadSurface: args=>{
        copies.push(args);
        return 0;
    } });
    const out = r.heap.allocate(4);
    assert.equal(r.call({ handler: rts.create }, [r.device, 128, 64, D3DFMT_A8R8G8B8,
        options.depth ? 1 : 0, D3DFMT_D16, out]), 0);
    const object = rts.objectAt(r.view.getUint32(out, true));
    /** @param {string} name @param {number[]} args */
    const invoke = (name, args = [])=>r.invoke(rts.renderToSurface, name, object, args);
    const device = r.objects.get(r.device);
    return { r, rts, invoke, copies, device, backBuffer: device.target, depth: device.depth };
}

test('D3DXCreateRenderToSurface refuses a null device or out-pointer; GetDesc is what it '
    + 'was made with', ()=>{
    const r = deviceRig();
    const rts = createRenderToSurface(r.host, { loadSurface: ()=>0 });
    const out = r.heap.allocate(4);
    assert.equal(r.call({ handler: rts.create }, [0, 1, 1, 21, 0, 0, out]), D3DERR_INVALIDCALL);
    assert.equal(r.call({ handler: rts.create }, [r.device, 1, 1, 21, 0, 0, 0]),
        D3DERR_INVALIDCALL);
    const { r: s, invoke } = setup({ depth: true });
    const desc = s.heap.allocate(20);
    assert.equal(invoke('GetDesc', [desc]), 0);
    assert.deepEqual([...new Uint32Array(s.memory.buffer, desc, 5)],
        [128, 64, D3DFMT_A8R8G8B8, 1, D3DFMT_D16]);
    assert.equal(invoke('GetDesc', [0]), D3DERR_INVALIDCALL);
});

test('a scene on a render target: the device pointed at it, then put back as it was', async()=>{
    const { r, invoke, device, backBuffer, depth } = setup();
    const texture = r.texture(128, 64, 1, 1, D3DFMT_A8R8G8B8, 0);
    const surface = r.objects.get(texture).surfaces[0];
    assert.equal(await invoke('BeginScene', [surface, 0]), 0);
    assert.equal(device.target, surface);
    assert.equal(device.depth, 0, 'made without a depth surface: none while drawing');
    assert.deepEqual(r.calls.map(c=>c[0]), ['GetDesc', 'GetRenderTarget',
        'GetDepthStencilSurface', 'GetViewport', 'SetRenderTarget', 'SetDepthStencilSurface',
        'BeginScene']);
    assert.equal(invoke('BeginScene', [surface, 0]), D3DERR_INVALIDCALL, 'already in one');
    r.calls.length = 0;
    assert.equal(await invoke('EndScene', [1]), 0);
    assert.deepEqual(r.calls.map(c=>c[0]), ['EndScene', 'SetRenderTarget',
        'SetDepthStencilSurface', 'SetViewport', 'Release', 'Release']);
    assert.equal(device.target, backBuffer);
    assert.equal(device.depth, depth);
    assert.deepEqual(r.viewport, [0, 0, 640, 480, 0, 1]);
    assert.deepEqual([r.objects.get(backBuffer).refs, r.objects.get(depth).refs], [1, 1],
        'the references Get took are given back');
    assert.equal(invoke('EndScene', [1]), D3DERR_INVALIDCALL, 'not in one');
    assert.equal(invoke('BeginScene', [0, 0]), D3DERR_INVALIDCALL);
});

test('the viewport the program gives is set for the scene', async()=>{
    const { r, invoke } = setup();
    const surface = r.surface({ width: 128, height: 64, format: 21, usage: 1, pool: 0 });
    const viewport = r.heap.allocate(24);
    new Uint32Array(r.memory.buffer, viewport, 4).set([8, 4, 32, 16]);
    r.putFloats(viewport + 16, [0, 1]);
    await invoke('BeginScene', [surface, viewport]);
    assert.deepEqual(r.viewport, [8, 4, 32, 16, 0, 1]);
    await invoke('EndScene', [1]);
    assert.deepEqual(r.viewport, [0, 0, 640, 480, 0, 1]);
});

test('a surface that is no render target is drawn through one of its size, copied at the end',
    async()=>{
        const { r, invoke, copies, device } = setup({ depth: true });
        const texture = r.texture(32, 16, 1, 0, D3DFMT_A8R8G8B8, 1);
        const surface = r.objects.get(texture).surfaces[0];
        assert.equal(await invoke('BeginScene', [surface, 0]), 0);
        const made = r.calls.find(c=>c[0] === 'CreateRenderTarget');
        assert.deepEqual(made?.slice(1, 7), [32, 16, D3DFMT_A8R8G8B8, 0, 0, 1],
            'lockable, so it can be copied from');
        const deep = r.calls.find(c=>c[0] === 'CreateDepthStencilSurface');
        assert.deepEqual(deep?.slice(1, 4), [32, 16, D3DFMT_D16]);
        const own = device.target;
        const ownDepth = device.depth;
        assert.notEqual(own, surface);
        assert.equal(r.objects.get(ownDepth).format, D3DFMT_D16);
        assert.equal(await invoke('EndScene', [1]), 0);
        assert.deepEqual(copies, [[surface, 0, 0, own, 0, 0, 1, 0]]);
        assert.deepEqual([r.objects.get(own).refs, r.objects.get(ownDepth).refs], [0, 0],
            'both let go');
    });
