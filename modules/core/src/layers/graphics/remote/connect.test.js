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
