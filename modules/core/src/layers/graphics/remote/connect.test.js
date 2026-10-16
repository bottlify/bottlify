/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectGraphicsWorker } from './connect.js';
import { createSender } from './channel.js';
import { WAIT } from './wire.js';
import { openGraphicsWorker } from '../../../host/graphics-worker.js';

/** A worker's end as `connectGraphicsWorker` and `openGraphicsWorker` see it. */
function fakeWorker(){
    const target = new EventTarget();
    /** @type {any[]} */
    const posted = [];
    return {
        posted,
        terminated: false,
        /** @param {any} message */
        postMessage(message){
            posted.push(message);
        },
        /** @param {any} data */
        answer(data){
            target.dispatchEvent(Object.assign(new Event('message'), { data }));
        },
        /** @param {string} type @param {any} listener */
        addEventListener: (type, listener)=>target.addEventListener(type, listener),
        /** @param {string} type @param {any} listener */
        removeEventListener: (type, listener)=>target.removeEventListener(type, listener),
        terminate(){
            this.terminated = true;
        },
    };
}

/** A GPU device's surface as far as a frame's copy goes. */
function fakeDevice(){
    /** @type {any[]} */
    const calls = [];
    return {
        calls,
        /** @param {any} descriptor */
        createTexture: descriptor=>({ descriptor, createView: ()=>({ view: true }),
            destroy: ()=>calls.push('destroy') }),
        queue: {
            /** @param {...any} args */
            writeTexture: (...args)=>calls.push(['writeTexture', ...args]),
            /** @param {...any} args */
            copyExternalImageToTexture: (...args)=>calls.push(['copyExternal', ...args]),
        },
    };
}

test('a frame the worker sends back is presented as one drawn here, its texture kept', ()=>{
    const worker = fakeWorker();
    const device = fakeDevice();
    /** @type {any[]} */
    const shown = [];
    const end = connectGraphicsWorker({ worker, device, presentTo: frame=>shown.push(frame) });
    const pixels = new Uint8Array(256 * 2);
    worker.answer({ type: 'frame', pixels, bytesPerRow: 256, width: 2, height: 2, frameIndex: 4,
        format: 'bgra8unorm' });
    let closed = false;
    worker.answer({ type: 'frame', bitmap: { width: 2, height: 2, close: ()=>{
        closed = true;
    } }, frameIndex: 5, format: 'bgra8unorm' });
    assert.deepEqual(shown.map(frame=>frame.frameIndex), [4, 5]);
    assert.equal(shown[0].surface, shown[1].surface, 'one texture for frames of one size');
    assert.equal(shown[0].surface.format, 'bgra8unorm');
    assert.deepEqual(device.calls.map(call=>call[0]), ['writeTexture', 'copyExternal']);
    assert.ok(closed, 'the picture is given back once copied');
    end.dispose();
    assert.ok(device.calls.includes('destroy'));
});

test('a frame the worker counted is presented with no picture, and nothing is drawn', ()=>{
    const worker = fakeWorker();
    const device = fakeDevice();
    /** @type {any[]} */
    const shown = [];
    const end = connectGraphicsWorker({ worker, device, presentTo: frame=>shown.push(frame),
        source: 3 });
    worker.answer({ type: 'frame', frameIndex: 9, source: 3 });
    assert.deepEqual(shown, [{ surface: null, frameIndex: 9, source: 3 }]);
    assert.deepEqual(device.calls, [], 'no texture made or written');
    assert.deepEqual(worker.posted.filter(message=>message.type === 'shown').length, 1,
        'and the worker told it was taken');
    end.dispose();
});

test('a picture this thread\'s device refuses has the worker send bytes from the next frame on',
    ()=>{
        const worker = fakeWorker();
        const device = fakeDevice();
        const refusal = Object.assign(new Error('External image state is not valid'),
            { name: 'InvalidStateError' });
        device.queue.copyExternalImageToTexture = ()=>{
            throw refusal;
        };
        /** @type {any[]} */
        const shown = [];
        const end = connectGraphicsWorker({ worker, device, presentTo: frame=>shown.push(frame) });
        let closed = false;
        const bitmap = { width: 2, height: 2, close: ()=>{
            closed = true;
        } };
        worker.answer({ type: 'frame', bitmap, frameIndex: 1, format: 'bgra8unorm' });
        assert.equal(shown.length, 0, 'the refused frame is not shown');
        assert.ok(closed, 'and its picture is given back');
        assert.deepEqual(worker.posted.map(message=>message.type), ['frames', 'shown']);
        assert.equal(worker.posted[0].frames, 'pixels');
        worker.answer({ type: 'frame', pixels: new Uint8Array(256 * 2), bytesPerRow: 256,
            width: 2, height: 2, frameIndex: 2, format: 'bgra8unorm' });
        assert.deepEqual(shown.map(frame=>frame.frameIndex), [2]);
        assert.equal(worker.posted.filter(message=>message.type === 'frames').length, 1,
            'asked once');
        end.dispose();
    });

test('two processes on one graphics worker show its frame once, and say so once', ()=>{
    const worker = fakeWorker();
    /** @type {string[]} */
    const shown = [];
    let lost = 0;
    /** @param {string} who */
    const connect = who=>connectGraphicsWorker({ worker, device: fakeDevice(),
        presentTo: ()=>shown.push(who), lost: ()=>lost++ });
    const parent = connect('parent');
    const child = connect('child');
    /** @param {number} frameIndex */
    const frame = frameIndex=>worker.answer({ type: 'frame', pixels: new Uint8Array(256 * 2),
        bytesPerRow: 256, width: 2, height: 2, frameIndex, format: 'bgra8unorm' });
    frame(1);
    assert.deepEqual(shown, ['child'], 'the newest process shows it, the other does not');
    assert.equal(worker.posted.filter(message=>message.type === 'shown').length, 1,
        'the worker is told once, so it sends the next once');
    worker.answer({ type: 'lost', reason: 'unknown' });
    assert.equal(lost, 2, 'every process loses what it drew there');
    child.dispose();
    frame(2);
    assert.deepEqual(shown, ['child', 'parent'], 'once the child is gone the parent shows them');
    assert.equal(worker.posted.filter(message=>message.type === 'shown').length, 2);
    parent.dispose();
    frame(3);
    assert.equal(shown.length, 2, 'nothing listens once both are gone');
});

test('a process that drew on the worker shows its frames over one that did not', ()=>{
    const worker = fakeWorker();
    /** @type {string[]} */
    const shown = [];
    /** @param {string} who */
    const connect = who=>connectGraphicsWorker({ worker, device: fakeDevice(),
        presentTo: ()=>shown.push(who) });
    const game = connect('game');
    game.root('d3d9', ()=>({}), {});
    const helper = connect('helper');
    try
    {
        worker.answer({ type: 'frame', pixels: new Uint8Array(256 * 2), bytesPerRow: 256,
            width: 2, height: 2, frameIndex: 1, format: 'bgra8unorm' });
        assert.deepEqual(shown, ['game']);
    }
    finally
    {
        helper.dispose();
        game.dispose();
    }
});

test('the worker\'s GPU going away is told, and a root is made over a port of its own', ()=>{
    const worker = fakeWorker();
    let lost = 0;
    const end = connectGraphicsWorker({ worker, lost: ()=>lost++ });
    worker.answer({ type: 'lost', reason: 'unknown' });
    assert.equal(lost, 1);
    const root = end.root('d3d9', (/** @type {any} */ services)=>({
        services,
        Hello: ()=>0,
    }), { vertexShaderVersion: { major: 2, minor: 0 }, readMemory: ()=>new Uint8Array(0),
        gamma: { applies: ()=>true, set(){} } });
    assert.equal(root.Hello(), 0);
    const message = worker.posted.find(posted=>posted.type === 'root');
    assert.equal(message.api, 'd3d9');
    assert.deepEqual(message.options, { vertexShaderVersion: { major: 2, minor: 0 },
        gamma: true }, 'what crosses is the plain part, and whether the ramp shows');
    end.dispose();
});

test('a present waits only once the played side owes more than its bound', async()=>{
    /** @type {any[]} */
    const posted = [];
    const sender = createSender({ post: message=>posted.push(message), framesAhead: 1 });
    assert.equal(sender.called(WAIT.PACED, 'Present'), undefined);
    const held = sender.called(WAIT.PACED, 'Present');
    assert.ok(held instanceof Promise, 'the second present waits for the first');
    let released = false;
    held.then(()=>{
        released = true;
    });
    await Promise.resolve();
    assert.equal(released, false);
    sender.receive({ type: 'presented', count: 1 });
    await held;
    assert.ok(released);
    assert.equal(posted.length, 2, 'each present sends what was written before it');
});

test('a graphics worker is used once it has a device, and given up when it has none', async()=>{
    const good = fakeWorker();
    const opening = openGraphicsWorker({ url: 'x', make: ()=>good });
    assert.deepEqual(good.posted, [{ type: 'open', frames: 'bitmap' }]);
    good.answer({ type: 'opened', adapter: { vendor: 'v' } });
    const opened = await opening;
    assert.equal(opened.worker, good);

    const bad = fakeWorker();
    const refusing = openGraphicsWorker({ url: 'x', make: ()=>bad, frames: 'pixels' });
    bad.answer({ type: 'failed', message: 'no adapter' });
    const refused = await refusing;
    assert.equal(refused.worker, null);
    assert.ok(bad.terminated);

    const silent = fakeWorker();
    const waited = await openGraphicsWorker({ url: 'x', make: ()=>silent, timeoutMs: 10 });
    assert.equal(waited.worker, null);
    assert.ok(silent.terminated);
});

test('a frame the worker\'s GPU refused is said, with how often it was', ()=>{
    const worker = fakeWorker();
    /** @type {string[]} */
    const said = [];
    const end = connectGraphicsWorker({ worker,
        divergence: (api, detail)=>said.push(`${api}: ${detail}`) });
    worker.answer({ type: 'refused', message: 'Invalid CommandBuffer', seen: 1 });
    worker.answer({ type: 'refused', message: 'Invalid CommandBuffer', seen: 256 });
    assert.deepEqual(said, ['graphics: the GPU refused a frame: Invalid CommandBuffer',
        'graphics: the GPU refused a frame: Invalid CommandBuffer (x256)']);
    end.dispose();
});

test('the worker\'s phase totals are summed over the roots that said them', async()=>{
    const worker = fakeWorker();
    const end = connectGraphicsWorker({ worker });
    const services = { readMemory: ()=>new Uint8Array(0), gamma: { applies: ()=>true, set(){} } };
    const factory = (/** @type {any} */ given)=>({ given });
    end.root('d3d9', factory, services);
    end.root('d3d9', factory, services);
    end.root('d3d9', factory, services);
    assert.equal(end.diagnostics().phases, null, 'nothing said yet: not measured');

    const ports = worker.posted.filter(posted=>posted.type === 'root').map(posted=>posted.port);
    /** @param {number} read @param {number} sweep */
    const phases = (read, sweep)=>({ 'batch-read': { count: 2, ms: read, selfMs: read - sweep },
        'batch-sweep': { count: 1, ms: sweep } });
    ports[0].postMessage({ type: 'diagnostics', diagnostics: {}, phases: phases(10, 4) });
    ports[1].postMessage({ type: 'diagnostics', diagnostics: {}, phases: phases(6, 1) });
    // The third root's played side times nothing: it is left out of the sum.
    ports[2].postMessage({ type: 'diagnostics', diagnostics: {} });
    await new Promise(resolve=>setTimeout(resolve, 10));

    assert.deepEqual(end.diagnostics().phases, {
        'batch-read': { count: 4, ms: 16, selfMs: 11 },
        'batch-sweep': { count: 2, ms: 5 },
    });
    for (const port of ports)
    {
        port.close();
    }
    end.dispose();
});
