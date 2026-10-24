/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveGraphics } from './worker.js';
import { createSender, sharedNow } from './channel.js';
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
            const [first] = frames();
            assert.equal(first.serial, 1, 'numbered, for its answer to name');
            assert.equal(typeof first.sentAt, 'number', 'it says when it went');
            assert.ok(first.waitedMs >= 0 && first.waitedMs <= sharedNow() - first.sentAt + 1e3);
            assert.deepEqual(first.back, { count: 0, ms: 0, maxMs: 0, early: 0 }, 'no answer yet');
            scope.onmessage({ data: { type: 'shown', at: sharedNow() - 5 } });
            await settle();
            assert.equal(frames().length, 2, 'the next once it was');
            assert.equal(frames()[1].frameIndex > frames()[0].frameIndex + 1, true,
                'the newest of those presented meanwhile');
            assert.equal(frames()[1].dropped, 1, 'the one it replaced counted');
            assert.equal(frames()[1].back.count, 1, 'the answer timed on its way back');
            assert.ok(frames()[1].back.ms >= 5 && frames()[1].back.maxMs === frames()[1].back.ms);
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

/**
 * A worker sending its frames as pictures, and a Direct3D 9 device that
 * presents to it: `present` draws one frame, presents it and lets it play.
 */
async function presentingWorker(){
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
    assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
        backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8 }, out),
    D3D_OK);
    let drawn = 0;
    return {
        scope,
        frames: ()=>posted.filter(message=>message.type === 'frame'),
        present: async()=>{
            out.device.BeginScene();
            out.device.Clear(0, null, D3DCLEAR.TARGET, 0xff000000 + drawn++, 1, 0);
            out.device.EndScene();
            await out.device.Present();
            await out.device.idle();
            await settle();
        },
        close: ()=>{
            port1.close();
            port2.close();
        },
    };
}

test('a frame the shared word says was shown lets the next go at its present, not at its answer',
    async()=>{
        // The answer is a message, which waits on a busy worker behind every
        // batch that came before it; the word is read at the present.
        const worker = await presentingWorker();
        const word = new Int32Array(new SharedArrayBuffer(4));
        worker.scope.onmessage({ data: { type: 'showing', word } });
        try
        {
            await worker.present();
            await worker.present();
            assert.equal(worker.frames().length, 1, 'none while the word says it is unshown');
            Atomics.store(word, 0, 1);
            await worker.present();
            assert.equal(worker.frames().length, 2, 'at the present after the word said it was');
            const second = worker.frames()[1];
            assert.equal(second.serial, 2);
            assert.equal(second.dropped, 1, 'the newest went, the one it replaced counted');
            assert.equal(second.back.early, 1, 'and said to have gone before its answer');
            worker.scope.onmessage({ data: { type: 'shown', at: sharedNow(), serial: 1 } });
            await settle();
            await worker.present();
            assert.equal(worker.frames().length, 2,
                'the first one\'s answer, come late, lets nothing go while the second is unshown');
            worker.scope.onmessage({ data: { type: 'shown', at: sharedNow(), serial: 2 } });
            await settle();
            assert.equal(worker.frames().length, 3, 'the second one\'s answer does');
        }
        finally
        {
            worker.close();
        }
    });

test('frames go one at a time with the shared word as with answers alone, and at once when shown',
    async()=>{
        // The second way a frame learns it may go, beside the answer: seeded
        // schedules of presents, of the showing thread taking a frame (and
        // writing the word) and of its answers arriving, down both. Neither
        // may send a frame while the one before is unshown; with the word, a
        // present that finds every frame sent shown sends its own at once.
        /** @param {number} seed */
        const seeded = seed=>{
            let state = seed;
            /** @param {number} n */
            return n=>{
                state ^= state << 13;
                state ^= state >>> 17;
                state ^= state << 5;
                return (state >>> 0) % n;
            };
        };
        for (const seed of [1, 2, 3, 4, 5, 6, 7, 8])
        {
            for (const shared of [false, true])
            {
                const below = seeded(seed);
                const worker = await presentingWorker();
                const word = shared ? new Int32Array(new SharedArrayBuffer(4)) : null;
                if (word)
                {
                    worker.scope.onmessage({ data: { type: 'showing', word } });
                }
                /** The serial of the last frame the showing thread took. */
                let shown = 0;
                /** @type {number[]} */
                const answers = [];
                const where = `seed ${seed}, ${shared ? 'with' : 'without'} the word`;
                try
                {
                    for (let step = 0; step < 40; step++)
                    {
                        const choice = below(3);
                        const sentBefore = worker.frames().length;
                        if (choice === 0)
                        {
                            await worker.present();
                            if (word && shown === sentBefore)
                            {
                                assert.equal(worker.frames().length, sentBefore + 1,
                                    `${where}, step ${step}: a present after the word said the last`
                                    + ' frame was shown sends its own');
                            }
                        }
                        else if (choice === 1 && shown < sentBefore)
                        {
                            shown = worker.frames()[shown].serial;
                            if (word)
                            {
                                Atomics.store(word, 0, shown);
                            }
                            answers.push(shown);
                        }
                        else if (choice === 2 && answers.length > 0)
                        {
                            worker.scope.onmessage({ data: { type: 'shown', at: sharedNow(),
                                serial: answers.shift() } });
                            await settle();
                        }
                        const sent = worker.frames();
                        assert.ok(sent.length <= shown + 1,
                            `${where}, step ${step}: a frame went before the last was shown`);
                        sent.forEach((frame, index)=>assert.equal(frame.serial, index + 1, where));
                    }
                }
                finally
                {
                    worker.close();
                }
            }
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

/**
 * A Direct3D 9 root on a worker whose GPU finishes nothing until told, made
 * with the frame bound given (absent, none is sent), and four frames presented
 * on it: what the worker then says of its bound, how many presents the
 * program's side still waits to hear played, and the GPU to finish them.
 *
 * @param {number} [frameLatency]
 */
async function presentedPastTheGpu(frameLatency){
    const gpu = createFakeDevice({ workDone: true });
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
    scope.onmessage({ data: { type: 'root', api: 'd3d9', options: {}, port: port2,
        ...frameLatency === undefined ? {} : { frameLatency } } });
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
        const before = sender.latency();
        for (let frame = 0; frame < 4; frame++)
        {
            out.device.BeginScene();
            out.device.Clear(0, null, D3DCLEAR.TARGET, 0xff000000 + frame, 1, 0);
            out.device.EndScene();
            await out.device.Present();
        }
        await settle();
        out.device.diagnostics();
        await sender.answered();
        const said = { before, latency: sender.latency(), behind: sender.behind() };
        gpu.finish();
        await settle();
        return { ...said, behindOnceFinished: sender.behind() };
    }
    finally
    {
        port1.close();
        port2.close();
    }
}

test('a present the worker held for its GPU is in what the worker says with its diagnostics',
    async()=>{
        // The fourth frame is one past Direct3D's bound of three, and its
        // present waits. The program's side sees that as a wait on the worker;
        // the bound's own count says it was the GPU.
        const { before, latency, behind, behindOnceFinished } = await presentedPastTheGpu();
        assert.equal(before, null, 'nothing said yet: not measured, never zero');
        assert.equal(latency?.limit, 3);
        assert.equal(latency?.frames, 4, 'every present counted');
        assert.equal(latency?.held, 1, 'the one past the bound waited for the GPU');
        assert.equal(latency?.waiting, 1, 'and still does');
        assert.equal(behind, 1, 'its frame not played, as far as the program knows');
        assert.equal(behindOnceFinished, 0, 'played once the GPU has finished the oldest');
    });

test('a root\'s presents are held to the frame bound it was made with', async()=>{
    // The run's `maxFrameLatency` reaches the worker with each root: one
    // frame lets the second present wait already, none never holds one.
    const one = await presentedPastTheGpu(1);
    assert.equal(one.latency?.limit, 1);
    assert.equal(one.latency?.held, 3, 'every present after the first');
    assert.equal(one.behind, 3);
    assert.equal(one.behindOnceFinished, 0);

    const none = await presentedPastTheGpu(0);
    assert.equal(none.latency?.limit, 0);
    assert.equal(none.latency?.frames, 4, 'still counted, so how far behind is there to read');
    assert.equal(none.latency?.held, 0, 'no bound, nothing held');
    assert.equal(none.latency?.peak, 4);
    assert.equal(none.behind, 0);
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

test('frozen on a shown frame, the worker sends what a message can carry', async()=>{
    const gpu = createFakeDevice();
    Object.assign(gpu.device, { queue: gpu.queue });
    /** @type {any[]} */
    const posted = [];
    // As a worker's postMessage: what cannot be cloned -- a GPU texture -- is refused.
    /** @type {any} */
    const scope = { postMessage: (/** @type {any} */ message)=>posted.push(structuredClone(message)),
        onmessage: null };
    serveGraphics(scope, {
        gpu: { requestAdapter: async()=>({ features: new Set(), info: {},
            requestDevice: async()=>gpu.device }) },
        canvas: (width, height)=>Object.assign(gpu.canvas, { width, height,
            transferToImageBitmap: ()=>({ width, height, close: ()=>{} }) }),
    });
    scope.onmessage({ data: { type: 'open', frames: 'pixels' } });
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
        out.device.BeginScene();
        out.device.Clear(0, null, D3DCLEAR.TARGET, 0xff000001, 1, 0);
        out.device.EndScene();
        await out.device.Present();
        await out.device.idle();
        await settle();
        scope.onmessage({ data: { type: 'debug', freeze: true } });
        const frozen = posted.find(message=>message.type === 'frozen');
        assert.ok(frozen, 'the frozen frame answered');
        assert.deepEqual(Object.keys(frozen).sort(), ['lines', 'sceneDraws', 'type']);
    }
    finally
    {
        // The replay's timer stops whatever the answer did.
        scope.onmessage({ data: { type: 'debug', freeze: false } });
        port1.close();
        port2.close();
    }
});
