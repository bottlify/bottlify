/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveGraphics } from './worker.js';
import { createSender } from './channel.js';
import { recordedDirect3D } from './direct3d.js';
import { createDirect3D9 } from '../d3d9/device.js';
import { D3DCLEAR, D3DFMT, D3DSWAPEFFECT, D3D_OK } from '../d3d8/constants.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/** Turns of the event loop, for what crosses ports and settles in promises. */
const settle = async(turns = 20)=>{
    for (let turn = 0; turn < turns; turn++)
    {
        await new Promise(resolve=>setImmediate(resolve));
    }
};

test('the worker sends one frame at a time, the newest, and counts those replaced unsent',
    async()=>{
        const gpu = createFakeDevice();
        // As a device a browser hands out carries its queue.
        Object.assign(gpu.device, { queue: gpu.queue });
        /** @type {any[]} */
        const posted = [];
        /** @type {any} */
        const scope = { postMessage: (/** @type {any} */ message)=>posted.push(message),
            onmessage: null };
        serveGraphics(scope, {
            gpu: { requestAdapter: async()=>({ features: new Set(), info: {},
                requestDevice: async()=>gpu.device }) },
            canvas: (width, height)=>Object.assign(gpu.canvas, { width, height,
                transferToImageBitmap: ()=>({ width, height, close: ()=>{} }) }),
        });
        scope.onmessage({ data: { type: 'open', frames: 'bitmap' } });
        await settle();
        const { port1, port2 } = new MessageChannel();
        scope.onmessage({ data: { type: 'root', api: 'd3d9', options: {}, port: port2 } });
        const sender = createSender({ post: (message, transfer)=>port1.postMessage(message,
            transfer), framesAhead: 100 });
        port1.onmessage = event=>sender.receive(event.data);
        const d3d = recordedDirect3D(createDirect3D9, {}, sender);
        /** @type {{ device?: any }} */
        const out = {};
        assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
            backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8 }, out),
        D3D_OK);
        const frames = ()=>posted.filter(message=>message.type === 'frame');
        try
        {
            for (let frame = 0; frame < 3; frame++)
            {
                out.device.BeginScene();
                out.device.Clear(0, null, D3DCLEAR.TARGET, 0xff000000 + frame, 1, 0);
                out.device.EndScene();
                await out.device.Present();
                await out.device.idle();
                await settle();
            }
            assert.equal(frames().length, 1, 'one sent while it is not yet shown');
            scope.onmessage({ data: { type: 'shown' } });
            await settle();
            assert.equal(frames().length, 2, 'the next once it was');
            assert.equal(frames()[1].frameIndex > frames()[0].frameIndex + 1, true,
                'the newest of those presented meanwhile');
            assert.equal(frames()[1].dropped, 1, 'the one it replaced counted');
            scope.onmessage({ data: { type: 'shown' } });
            await settle();
            assert.equal(frames().length, 2, 'and nothing more until another is presented');
        }
        finally
        {
            port1.close();
            port2.close();
        }
    });

test('told to, the worker sends its frames as bytes from then on', async()=>{
    const gpu = createFakeDevice();
    Object.assign(gpu.device, { queue: gpu.queue });
    /** @type {any[]} */
    const posted = [];
    /** @type {any} */
    const scope = { postMessage: (/** @type {any} */ message)=>posted.push(message),
        onmessage: null };
    serveGraphics(scope, {
        gpu: { requestAdapter: async()=>({ features: new Set(), info: {},
            requestDevice: async()=>gpu.device }) },
        canvas: (width, height)=>Object.assign(gpu.canvas, { width, height,
            transferToImageBitmap: ()=>({ width, height, close: ()=>{} }) }),
    });
    scope.onmessage({ data: { type: 'open', frames: 'bitmap' } });
    await settle();
    const { port1, port2 } = new MessageChannel();
    scope.onmessage({ data: { type: 'root', api: 'd3d9', options: {}, port: port2 } });
    const sender = createSender({ post: (message, transfer)=>port1.postMessage(message,
        transfer), framesAhead: 100 });
    port1.onmessage = event=>sender.receive(event.data);
    const d3d = recordedDirect3D(createDirect3D9, {}, sender);
    /** @type {{ device?: any }} */
    const out = {};
    d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
        backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8 }, out);
    const frames = ()=>posted.filter(message=>message.type === 'frame');
    const draw = async(/** @type {number} */ colour)=>{
        out.device.BeginScene();
        out.device.Clear(0, null, D3DCLEAR.TARGET, colour, 1, 0);
        out.device.EndScene();
        await out.device.Present();
        await out.device.idle();
        await settle();
    };
    try
    {
        await draw(0xff000001);
        assert.ok(frames()[0].bitmap, 'a picture first');
        scope.onmessage({ data: { type: 'frames', frames: 'pixels' } });
        scope.onmessage({ data: { type: 'shown' } });
        await draw(0xff000002);
        assert.equal(frames().length, 2);
        assert.equal(frames()[1].bitmap, undefined);
        assert.ok(frames()[1].pixels instanceof Uint8Array, 'then bytes');
        assert.equal(frames()[1].width, 8);
    }
    finally
    {
        port1.close();
        port2.close();
    }
});

test('asked for its diagnostics, the played device answers, and the asker can wait for it',
    async()=>{
        const gpu = createFakeDevice();
        Object.assign(gpu.device, { queue: gpu.queue });
        /** @type {any} */
        const scope = { postMessage: ()=>{}, onmessage: null };
        serveGraphics(scope, {
            gpu: { requestAdapter: async()=>({ features: new Set(), info: {},
                requestDevice: async()=>gpu.device }) },
            canvas: (width, height)=>Object.assign(gpu.canvas, { width, height,
                transferToImageBitmap: ()=>({ width, height, close: ()=>{} }) }),
        });
        scope.onmessage({ data: { type: 'open', frames: 'bitmap' } });
        await settle();
        const { port1, port2 } = new MessageChannel();
        scope.onmessage({ data: { type: 'root', api: 'd3d9', options: {}, port: port2 } });
        const sender = createSender({ post: (message, transfer)=>port1.postMessage(message,
            transfer), framesAhead: 100 });
        port1.onmessage = event=>sender.receive(event.data);
        const d3d = recordedDirect3D(createDirect3D9, {}, sender);
        /** @type {{ device?: any }} */
        const out = {};
        d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
            backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8 }, out);
        try
        {
            for (let frame = 0; frame < 2; frame++)
            {
                out.device.BeginScene();
                out.device.Clear(0, null, D3DCLEAR.TARGET, 0xff000000 + frame, 1, 0);
                out.device.EndScene();
                await out.device.Present();
            }
            assert.equal(out.device.diagnostics(), null, 'the first ask has nothing to say yet');
            await sender.answered();
            assert.equal(out.device.diagnostics()?.frames, 2, 'once answered, the frames played');
        }
        finally
        {
            port1.close();
            port2.close();
        }
    });
