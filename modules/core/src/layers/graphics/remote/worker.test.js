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

test('counting, the worker says every frame presented, without its picture', async()=>{
    // A run on a device that draws nothing measures the engine alone; its
    // frame rate is the program's presents, which a kept picture would hide.
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
        canvas: ()=>{
            throw new Error('a counted frame needs no canvas');
        },
    });
    scope.onmessage({ data: { type: 'open', frames: 'count' } });
    await settle();
    const { port1, port2 } = new MessageChannel();
    scope.onmessage({ data: { type: 'root', api: 'd3d9', options: {}, port: port2, source: 7 } });
    const sender = createSender({ post: (message, transfer)=>port1.postMessage(message,
        transfer), framesAhead: 100 });
    port1.onmessage = event=>sender.receive(event.data);
    const d3d = recordedDirect3D(createDirect3D9, {}, sender);
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
        backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8 }, out),
    D3D_OK);
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
        const frames = posted.filter(message=>message.type === 'frame');
        assert.equal(frames.length, 3, 'every frame, none waiting to be shown');
        assert.deepEqual(frames.map(message=>Object.keys(message).sort()),
            Array(3).fill(['frameIndex', 'source', 'type']), 'and no picture with any');
        assert.equal(frames[2].frameIndex > frames[0].frameIndex, true);
        assert.equal(frames[0].source, 7, 'whose it is');
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

test('a client port takes roots as the worker does, and is told when the GPU goes away',
    async()=>{
        const gpu = createFakeDevice();
        Object.assign(gpu.device, { queue: gpu.queue });
        /** @type {(info: { reason: string }) => void} */
        let loseDevice = ()=>{};
        Object.assign(gpu.device, { lost: new Promise(resolve=>{
            loseDevice = resolve;
        }) });
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
        // A process in another worker: its own way in, over which it makes roots.
        const client = new MessageChannel();
        scope.onmessage({ data: { type: 'client', port: client.port2 } });
        /** @type {any[]} */
        const told = [];
        client.port1.onmessage = event=>told.push(event.data);
        const { port1, port2 } = new MessageChannel();
        client.port1.postMessage({ type: 'root', api: 'd3d9', options: {}, port: port2 },
            [port2]);
        const sender = createSender({ post: (message, transfer)=>port1.postMessage(message,
            transfer), framesAhead: 100 });
        port1.onmessage = event=>sender.receive(event.data);
        const d3d = recordedDirect3D(createDirect3D9, {}, sender);
        /** @type {{ device?: any }} */
        const out = {};
        try
        {
            assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD,
                backBufferCount: 1, backBufferWidth: 8, backBufferHeight: 8,
                backBufferFormat: D3DFMT.X8R8G8B8 }, out), D3D_OK);
            out.device.BeginScene();
            out.device.Clear(0, null, D3DCLEAR.TARGET, 0xff000000, 1, 0);
            out.device.EndScene();
            await out.device.Present();
            await out.device.idle();
            await settle();
            assert.equal(posted.filter(message=>message.type === 'frame').length, 1,
                'its frames come back to the thread that shows them, as every root\'s do');
            loseDevice({ reason: 'unknown' });
            await settle();
            assert.deepEqual(told, [{ type: 'lost', reason: 'unknown' }],
                'and its devices are lost with the GPU');
            assert.ok(posted.some(message=>message.type === 'lost'));
        }
        finally
        {
            port1.close();
            client.port1.close();
        }
    });

test('each process\'s frames keep a slot of their own, say whose they are, and are sent in turn',
    async()=>{
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
        /** @type {MessagePort[]} */
        const ports = [];
        /** @param {number} source @param {number} size */
        const deviceOf = (source, size)=>{
            const { port1, port2 } = new MessageChannel();
            ports.push(port1, port2);
            scope.onmessage({ data: { type: 'root', api: 'd3d9', options: {}, port: port2,
                source } });
            const sender = createSender({ post: (message, transfer)=>port1.postMessage(message,
                transfer), framesAhead: 100 });
            port1.onmessage = event=>sender.receive(event.data);
            /** @type {{ device?: any }} */
            const out = {};
            recordedDirect3D(createDirect3D9, {}, sender).CreateDevice({
                swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1, backBufferWidth: size,
                backBufferHeight: size, backBufferFormat: D3DFMT.X8R8G8B8 }, out);
            return out.device;
        };
        /** @param {any} device */
        const draw = async device=>{
            device.BeginScene();
            device.Clear(0, null, D3DCLEAR.TARGET, 0xff000000, 1, 0);
            device.EndScene();
            await device.Present();
            await device.idle();
            await settle();
        };
        const frames = ()=>posted.filter(message=>message.type === 'frame');
        try
        {
            const first = deviceOf(0x100, 8);
            const second = deviceOf(0x200, 16);
            await draw(first);
            await draw(second);
            await draw(first);
            await draw(first);
            assert.deepEqual(frames().map(frame=>frame.source), [0x100],
                'one in flight, whoever presents');
            scope.onmessage({ data: { type: 'shown' } });
            await settle();
            assert.equal(frames()[1].source, 0x200,
                'the other process\'s next, though the first presented since');
            assert.equal(frames()[1].bitmap.width, 16, 'from its own slot');
            scope.onmessage({ data: { type: 'shown' } });
            await settle();
            assert.equal(frames()[2].source, 0x100, 'then the first\'s newest');
            assert.equal(frames()[2].dropped, 1, 'the one of its own it replaced counted');
        }
        finally
        {
            for (const port of ports)
            {
                port.close();
            }
        }
    });

test('a validation error of the worker\'s GPU is sent on, once and then every 256th', async()=>{
    const gpu = createFakeDevice();
    Object.assign(gpu.device, { queue: gpu.queue });
    /** @type {((event: any) => void)[]} */
    const listeners = [];
    const listen = gpu.device.addEventListener;
    gpu.device.addEventListener = (type, listener)=>{
        listeners.push(listener);
        listen(type, listener);
    };
    /** @type {any[]} */
    const posted = [];
    /** @type {any} */
    const scope = { postMessage: (/** @type {any} */ message)=>posted.push(message),
        onmessage: null };
    serveGraphics(scope, {
        gpu: { requestAdapter: async()=>({ features: new Set(), info: {},
            requestDevice: async()=>gpu.device }) },
        canvas: ()=>gpu.canvas,
    });
    scope.onmessage({ data: { type: 'open', frames: 'none' } });
    await settle();
    assert.equal(listeners.length, 1, 'the worker listens');
    for (let time = 0; time < 300; time++)
    {
        listeners[0]({ error: {
            message: `Invalid  CommandBuffer "frame#${time}"\n is invalid.` } });
    }
    assert.deepEqual(posted.filter(message=>message.type === 'refused'), [
        { type: 'refused', message: 'Invalid CommandBuffer "frame#0" is invalid.', seen: 1 },
        { type: 'refused', message: 'Invalid CommandBuffer "frame#255" is invalid.', seen: 256 },
    ], 'counted alike whichever frame it names');
});
