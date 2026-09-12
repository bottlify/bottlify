/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteApp } from './remote.js';
import { serveEngine, watchFrom, workerPacing } from './serve.js';

/**
 * Both ends of the wire, joined by a real MessageChannel: what the page sends
 * is what the worker gets, structured clone and all, and the only stand-ins
 * are the application behind the worker and the GPU it would open.
 */

/** A wait for everything queued on the ports to be delivered. */
const settled = ()=>new Promise(resolve=>setTimeout(resolve, 20));

/** Every channel opened, closed at the end: an open port keeps the process alive. */
/** @type {(() => void)[]} */
const opened = [];
after(()=>{
    for (const close of opened)
    {
        close();
    }
});

/** An application, as far as the wire is concerned. */
function fakeApp(){
    /** @type {Map<string, ((payload: any) => void)[]>} */
    const listeners = new Map();
    /** @type {any[]} */
    const records = [];
    const app = {
        options: /** @type {any} */ (null),
        sent: /** @type {any[]} */ ([]),
        attached: /** @type {any[]} */ ([]),
        levels: /** @type {any[]} */ ([]),
        disposed: 0,
        exitWith: /** @type {number | Error} */ (7),
        /** @param {string} name @param {any} payload */
        emit(name, payload){
            for (const handler of listeners.get(name) ?? [])
            {
                handler(payload);
            }
        },
        /** @param {string} text */
        write(text){
            records.push({ sequence: records.length, time: 0, levelName: 'info',
                category: 'test', text });
        },
        on: (/** @type {string} */ name, /** @type {(payload: any) => void} */ handler)=>{
            listeners.set(name, [...listeners.get(name) ?? [], handler]);
        },
        async run(){
            if (app.exitWith instanceof Error)
            {
                throw app.exitWith;
            }
            return app.exitWith;
        },
        pause(){},
        resume(){},
        stop(){},
        input: {
            /** @param {any} canvas @param {any} options */
            attach: (canvas, options)=>{
                app.attached.push({ canvas, options });
            },
            detach(){},
            send: (/** @type {any} */ event)=>{
                app.sent.push(event);
            },
        },
        audio: {
            ring: ()=>({ memory: { control: new ArrayBuffer(16), samples: new ArrayBuffer(64) } }),
            format: ()=>({ sampleRate: 48000, channels: 2 }),
        },
        log: {
            /** @param {number} since @param {number} limit */
            drain: (since, limit)=>{
                const taken = records.slice(since, since + limit);
                return { records: taken, from: since, next: since + taken.length, lost: 0 };
            },
            setDefaultLevel: (/** @type {any} */ level)=>{
                app.levels.push(level);
            },
        },
        registry: ()=>({ toJSON: ()=>({ HKLM: {} }) }),
        session: { export: ()=>[{ path: 'C:\\a.txt', bytes: Uint8Array.of(1, 2) }] },
        diagnostics: ()=>[
            { name: 'cpu', metrics: { instructions: 5, ring: ()=>0,
                tail: Uint8Array.of(1, 2), texels: new Uint8Array(4096),
                handle: Object.create({ inherited: 1 }), pages: new Map([[1, 2]]) } },
            { name: 'audio', metrics: { tracks: 2 } },
        ],
        debug: { hook: ()=>({}) },
        dispose(){
            app.disposed++;
        },
    };
    return app;
}

/** The GPU the worker would open, and the canvas it would draw into. */
function fakeGpu(){
    const device = {
        queue: { submit(){} },
        addEventListener(){},
        createCommandEncoder: ()=>({ copyTextureToTexture(){}, finish(){} }),
    };
    return {
        gpu: {
            requestAdapter: async()=>({
                features: new Set(['texture-compression-bc']),
                info: { vendor: 'fake', architecture: '', description: 'a stand-in' },
                requestDevice: async()=>device,
            }),
        },
        // A size that crosses the port, and the context it would give.
        canvas: { width: 0, height: 0 },
        screen: { configure(){}, getCurrentTexture: ()=>({}) },
    };
}

/**
 * A page canvas the DOM adapter can listen to.
 * @param {{ width: number, height: number }} size
 */
function fakeViewport({ width, height }){
    /** @type {Map<string, ((event: any) => void)[]>} */
    const handlers = new Map();
    return {
        width,
        height,
        tabIndex: -1,
        style: { outline: '' },
        hasAttribute: ()=>false,
        /** @param {string} type @param {(event: any) => void} handler */
        addEventListener(type, handler){
            handlers.set(type, [...handlers.get(type) ?? [], handler]);
        },
        /** @param {string} type @param {(event: any) => void} handler */
        removeEventListener(type, handler){
            handlers.set(type, (handlers.get(type) ?? []).filter(one=>one !== handler));
        },
        getBoundingClientRect: ()=>({ left: 0, top: 0, width, height }),
        focus(){},
        blur(){},
        setPointerCapture(){},
        releasePointerCapture(){},
        /** @param {string} type @param {any} event */
        fire(type, event){
            for (const handler of handlers.get(type) ?? [])
            {
                handler({ preventDefault(){}, timeStamp: 0, ...event });
            }
        },
    };
}

/**
 * @param {Partial<import('./messages.js').StartOptions>} [options]
 * @param {{ threaded?: boolean }} [deps]
 */
async function connect(options = {}, deps = {}){
    const channel = new MessageChannel();
    const app = fakeApp();
    const { gpu, canvas, screen } = fakeGpu();
    /** @type {any} */
    let built = null;
    const serving = serveEngine(channel.port2, {
        gpu,
        screenOf: ()=>screen,
        now: ()=>0,
        ...deps,
        createApp: async appOptions=>{
            built = appOptions;
            app.options = appOptions;
            return app;
        },
    });
    const worker = Object.assign(/** @type {any} */ (channel.port1), { terminated: 0, terminate(){
        worker.terminated++;
        serving.close();
        channel.port1.close();
        channel.port2.close();
    } });
    opened.push(()=>worker.terminate());
    const remote = await createRemoteApp({
        worker,
        canvas,
        options: {
            executable: Uint8Array.of(0x4d, 0x5a),
            v86: { moduleUrl: 'v86.mjs', wasmBytes: new ArrayBuffer(4) },
            imagePath: 'C:\\App\\a.exe',
            bundle: { url: 'http://bundle/b.btl', id: 'b', store: null },
            ...options,
        },
    });
    return { remote, app, worker, canvas, built: ()=>built };
}

test('start rebuilds on the worker what could not cross: fetch, device, watch, storage', async()=>{
    const { remote, built } = await connect({
        watch: { libraries: { 'storm.dll': null, 'game.dll': [268] }, strings: [0] },
        storage: { files: [{ path: 'C:\\Install\\setup.exe', bytes: Uint8Array.of(9) }] },
        device: { fog: false, maxDraws: 3 },
    });
    const options = built();
    assert.equal(typeof options.bundle.fetch, 'function');
    assert.equal(options.bundle.id, 'b');
    assert.equal(typeof options.device.presentTo, 'function');
    assert.equal(options.device.fog, false);
    assert.equal(options.device.maxDraws, 3);
    assert.deepEqual(options.device.adapter, { vendor: 'fake', architecture: '',
        description: 'a stand-in' });
    assert.equal(options.watchImport('STORM.dll', '_Foo@8', 1)?.args, 2);
    assert.equal(options.watchImport('game.dll', null, 268)?.args, 6);
    assert.equal(options.watchImport('other.dll', '_Foo@8', 1), null);
    assert.deepEqual(await options.storage.load(),
        [{ path: 'C:\\Install\\setup.exe', bytes: Uint8Array.of(9) }]);
    assert.deepEqual(remote.adapter, { vendor: 'fake', architecture: '',
        description: 'a stand-in' });
    await remote.dispose();
});

test('the sound ring crosses once, at start', async()=>{
    const { remote, app } = await connect();
    const ring = remote.audio.ring();
    assert.equal(ring.memory.samples.byteLength, 64);
    assert.deepEqual(remote.audio.format(), { sampleRate: 48000, channels: 2 });
    assert.equal(app.attached.length, 1);
    assert.deepEqual(app.attached[0].options, { listen: false });
    await remote.dispose();
});

test('an input event arrives at the router as it left the page', async()=>{
    const { remote, app } = await connect();
    remote.input.send({ kind: 'key', code: 'KeyA', down: true });
    remote.input.send({ kind: 'pointerMove', x: 10, y: 20, dx: 1, dy: -1 });
    await settled();
    assert.deepEqual(app.sent, [
        { kind: 'key', code: 'KeyA', down: true },
        { kind: 'pointerMove', x: 10, y: 20, dx: 1, dy: -1 },
    ]);
    await remote.dispose();
});

test('a DOM event captured on the page is scaled by the frame the worker presented', async()=>{
    const { remote, app, built } = await connect();
    // The page's canvas is 320x240 on screen and keeps saying so; the worker
    // presents at 640x480, which is the space a click lives in.
    const viewport = fakeViewport({ width: 320, height: 240 });
    remote.input.attach(viewport);
    built().device.presentTo({ frameIndex: 0,
        surface: { width: 640, height: 480, format: 'bgra8unorm', texture: {} } });
    await settled();
    assert.equal(remote.frames(), 1);
    viewport.fire('pointerdown', { clientX: 160, clientY: 120, button: 0, pointerId: 1 });
    await settled();
    const move = app.sent.find(event=>event.kind === 'pointerMove');
    assert.deepEqual([move.x, move.y], [320, 240]);
    assert.ok(app.sent.some(event=>event.kind === 'pointerButton' && event.button === 'left'));
    remote.input.detach();
    await settled();
    assert.equal(app.attached.length, 2);
    await remote.dispose();
});

test('a subscribed event reaches the page with its bytes intact', async()=>{
    const { remote, app } = await connect();
    /** @type {any[]} */
    const seen = [];
    remote.on('cursor', (/** @type {any} */ payload)=>seen.push(payload));
    await settled();
    app.emit('cursor', { width: 2, height: 1, hotSpot: { x: 0, y: 0 },
        bgra: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8), shown: true });
    await settled();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].bgra, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
    await remote.dispose();
});

test('run answers with the exit code and what the exit left behind', async()=>{
    const { remote } = await connect({ collectOnExit: true });
    assert.throws(()=>remote.session.export(), /not exited/);
    assert.equal(await remote.run({ maxTurns: 5 }), 7);
    assert.deepEqual(remote.session.export(), [{ path: 'C:\\a.txt', bytes: Uint8Array.of(1, 2) }]);
    assert.deepEqual(remote.registry().toJSON(), { HKLM: {} });
    await remote.dispose();
});

test('a failed run rejects with the reason and trace the page shows', async()=>{
    const { remote, app } = await connect();
    app.exitWith = Object.assign(new Error('the guest faulted'),
        { reason: 'guest-fault', traceText: 'eip=0x1234' });
    await assert.rejects(remote.run(), (/** @type {any} */ e)=>{
        assert.equal(e.message, 'the guest faulted');
        assert.equal(e.reason, 'guest-fault');
        assert.equal(e.traceText, 'eip=0x1234');
        return true;
    });
    await remote.dispose();
});

test('the journal mirror follows the ring and answers a drain as the ring would', async()=>{
    const { remote, app } = await connect();
    app.write('one');
    app.write('two');
    await remote.run();
    assert.deepEqual(remote.log.recent(1).map((/** @type {any} */ r)=>r.text), ['two']);
    const first = remote.log.drain(0, 10);
    assert.deepEqual(first.records.map((/** @type {any} */ r)=>r.text), ['one', 'two']);
    assert.equal(first.next, 2);
    const nothing = remote.log.drain(first.next, 10);
    assert.deepEqual(nothing, { records: [], from: 2, next: 2, lost: 0 });
    await remote.log.setDefaultLevel('debug');
    assert.deepEqual(app.levels, ['debug']);
    await remote.dispose();
});

test('diagnostics cross as they are, less what a clone refuses, whole or one layer', async()=>{
    const { remote } = await connect();
    const layers = await remote.diagnostics();
    assert.equal(layers.length, 2);
    assert.equal(layers[0].metrics.instructions, 5);
    assert.equal('ring' in layers[0].metrics, false, 'a function is left out');
    assert.deepEqual(layers[0].metrics.tail, Uint8Array.of(1, 2), 'bytes stay bytes');
    assert.equal(layers[0].metrics.texels.byteLength, 4096, 'large ones too, uncut');
    assert.deepEqual(layers[0].metrics.handle, {}, 'an object with nothing of its own is empty');
    assert.deepEqual(layers[0].metrics.pages, new Map([[1, 2]]));
    const one = await remote.diagnostics('audio');
    assert.deepEqual(one, [{ name: 'audio', metrics: { tracks: 2 } }]);
    assert.deepEqual(await remote.diagnostics('nothing'), []);
    const counted = remote.traffic();
    assert.ok(counted.request >= 3 && counted.answer >= 3, 'the port counts what crossed');
    await remote.dispose();
});

test('visibility reaches the engine as pacing, never as an event', async()=>{
    const { remote, app, built, worker } = await connect();
    assert.equal(built().pageHidden(), false);
    worker.postMessage({ type: 'visibility', hidden: true });
    await settled();
    assert.equal(built().pageHidden(), true);
    assert.equal(app.sent.length, 0);
    await remote.dispose();
});

test('disposing rejects whatever was still waiting and leaves the worker to the caller', async()=>{
    const { remote, app, worker } = await connect();
    app.run = ()=>new Promise(()=>{});
    const running = remote.run();
    await remote.dispose();
    await assert.rejects(running, /disposed/);
    assert.equal(app.disposed, 1);
    assert.equal(worker.terminated, 0);
    await assert.rejects(remote.diagnostics(), /gone/);
    worker.terminate();
});

test('a second program starts in the same worker with the canvas it already has', async()=>{
    const { remote, worker, built } = await connect();
    await remote.dispose();
    const again = await createRemoteApp({ worker, options: {
        executable: Uint8Array.of(0x4d, 0x5a),
        v86: { moduleUrl: 'v86.mjs', wasmBytes: new ArrayBuffer(4) },
    } });
    assert.equal(typeof built().device.presentTo, 'function');
    assert.equal(again.frames(), 0);
    await again.dispose();
    worker.terminate();
});

test('a watch spec names libraries whole or by ordinal', ()=>{
    const watch = watchFrom({ libraries: { 'a.dll': null, 'b.dll': [3, 4] }, strings: [1] });
    assert.deepEqual(watch('A.DLL', '_Name@12', 9), { args: 3 });
    assert.deepEqual(watch('a.dll', null, 9), { args: 6 });
    assert.equal(watch('a.dll', 'Undecorated', 9), null);
    assert.deepEqual(watch('b.dll', null, 4), { args: 6, strings: [1] });
    assert.equal(watch('b.dll', null, 5), null);
    assert.equal(watch('c.dll', '_Name@12', 9), null);
});

test('a worker runs turns back to back and yields only for something pending', ()=>{
    let now = 0;
    let signalled = false;
    let yields = 0;
    const pacing = workerPacing({
        macrotask: async()=>{
            yields++;
        },
        poke: ()=>new Promise(()=>{}),
        signalled: ()=>signalled,
        now: ()=>now,
    });
    const nothing = { suspended: 0, fetching: 0, idlers: 0 };
    assert.equal(pacing.yield(nothing), null);
    assert.equal(pacing.yield(nothing), null);
    assert.ok(pacing.yield({ ...nothing, suspended: 1 }), 'a call suspended on the host');
    assert.ok(pacing.yield({ ...nothing, fetching: 1 }), 'a range in flight');
    assert.ok(pacing.yield({ ...nothing, idlers: 1 }), 'a caller on an empty queue');
    signalled = true;
    assert.ok(pacing.yield(nothing), 'the page posted something');
    signalled = false;
    assert.equal(pacing.yield(nothing), null);
    now += 2;
    assert.ok(pacing.yield(nothing), 'a millisecond of turns without a yield');
    assert.equal(yields, 5);
});

test('an idle worker sleeps to the deadline, or until the page or the host speaks', async()=>{
    /** @type {(() => void) | null} */
    let wake = null;
    const pacing = workerPacing({
        macrotask: async()=>{},
        poke: ()=>new Promise(resolve=>{
            wake = resolve;
        }),
        signalled: ()=>false,
        now: ()=>performance.now(),
    });
    let before = performance.now();
    await pacing.wait({ timer: true, sleep: true, deadlineMs: 20, wakes: [] });
    assert.ok(performance.now() - before >= 15, 'nothing else spoke: the deadline is the wake');

    before = performance.now();
    const waiting = pacing.wait({ timer: true, sleep: true, deadlineMs: 5000, wakes: [] });
    setTimeout(()=>wake?.(), 5);
    await waiting;
    assert.ok(performance.now() - before < 1000, 'a message from the page ends the wait');

    before = performance.now();
    await pacing.wait({ timer: true, sleep: true, deadlineMs: null,
        wakes: [new Promise(resolve=>setTimeout(resolve, 5))] });
    assert.ok(performance.now() - before < 1000, 'a host answer ends a wait with no deadline');

    before = performance.now();
    await pacing.wait({ timer: false, sleep: false, deadlineMs: 5000, wakes: [] });
    assert.ok(performance.now() - before < 100,
        'a thread still getting work done is not put to sleep, whatever the deadline');
});

test('the page counts what it posts, and the worker sees it between two turns', async()=>{
    const same = await connect();
    assert.equal(same.built().pacing, undefined, 'a port on the same thread keeps the page pacing');
    await same.remote.dispose();

    const looks = await connect({}, { threaded: true });
    assert.equal(looks.built().pacing, undefined, 'a worker keeps the page pacing unless asked');
    await looks.remote.dispose();

    const { remote, built } = await connect({ pacing: 'event' }, { threaded: true });
    const pacing = built().pacing;
    const nothing = { suspended: 0, fetching: 0, idlers: 0 };
    assert.equal(typeof pacing.yield, 'function');
    assert.equal(pacing.yield(nothing), null, 'nothing posted since start');
    remote.input.send({ kind: 'key', code: 'KeyA', down: true });
    // Seen before the event loop has delivered the message: that is the point
    // of the shared word.
    assert.ok(pacing.yield(nothing), 'the post is visible at once');
    assert.equal(pacing.yield(nothing), null, 'and counted once');
    await settled();
    await remote.dispose();
});
