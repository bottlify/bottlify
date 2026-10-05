/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteApp } from './remote.js';
import {
    postAsItIs, serveEngine, watchFrom, workerPacing, WORKER_YIELD_MS,
} from './serve.js';
import { serveKeeper } from './keeper.js';
import { PAGE_YIELD_MS } from '../app.js';
import { createEvents } from '../events.js';
import { createRing } from '../layers/audio/output/ring.js';
import { createJournal, Level } from '../layers/log/internal/journal.js';
import { createMetrics } from '../layers/log/internal/metrics.js';
import {
    createProfiler, FRAME_COLUMNS, PHASE_COLUMNS, PHASE_ROWS,
} from '../layers/log/internal/profiler.js';

/**
 * Both ends of the wire, joined by a real MessageChannel: what the page sends
 * is what the worker gets, structured clone and all, and the only stand-ins
 * are the application behind the worker and the GPU it would open.
 */

/** A wait for everything queued on the ports to be delivered. */
const settled = ()=>new Promise(resolve=>setTimeout(resolve, 20));

/** Waits for a condition to hold, so no test depends on a keeper poll landing in time. */
/** @param {() => Promise<boolean> | boolean} check @param {number} [timeoutMs] */
const until = async(check, timeoutMs = 2000)=>{
    const deadline = Date.now() + timeoutMs;
    for (;;)
    {
        if (await check())
        {
            return;
        }
        if (Date.now() > deadline)
        {
            throw new Error('timed out waiting for the keeper');
        }
        await settled();
    }
};

/** Every channel opened, closed at the end: an open port keeps the process alive. */
/** @type {(() => void)[]} */
const opened = [];
after(()=>{
    for (const close of opened)
    {
        close();
    }
});

/**
 * An application, as far as the wire is concerned.
 *
 * The log is the real thing rather than a stand-in: the whole point of the
 * wire's log half is that one side writes a journal and a table and the other
 * reads them out of the same memory, and a fake in the middle would prove
 * nothing about that. `shared: false` builds the same layout in an
 * `ArrayBuffer`, which is what an origin without cross-origin isolation gets
 * and what puts the page back on the request path.
 *
 * @param {{ capacity?: number, shared?: boolean, audioShared?: boolean }} [how]
 */
function fakeApp({ capacity = 4096, shared = true, audioShared = false } = {}){
    // The real registry, not a hand-rolled stand-in: the whole point of the
    // events tests below is that a late `on()` still catches what an early
    // `emit()` fired, and that is `events.js`'s contract to keep, not this
    // fake's to reimplement.
    const events = createEvents();
    // The engine mixer's own ring, with a little already mixed into it.
    const ring = createRing({ channels: 2, capacityFrames: 8 });
    ring.write(Float32Array.of(1, -1, 2, -2, 3, -3));
    const journal = createJournal({ now: ()=>0, capacity, shared });
    const registry = createMetrics({ shared });
    const own = registry.counters('log', ['rejected']);
    const profiler = createProfiler({
        now: ()=>0,
        tables: {
            frames: registry.table('log', 'frames', { rows: 8, columns: FRAME_COLUMNS }),
            phases: registry.table('log', 'phases',
                { rows: PHASE_ROWS, columns: PHASE_COLUMNS }),
        },
        intern: journal.intern,
    });
    const app = {
        ring,
        options: /** @type {any} */ (null),
        sent: /** @type {any[]} */ ([]),
        attached: /** @type {any[]} */ ([]),
        levels: /** @type {any[]} */ ([]),
        disposed: 0,
        exitWith: /** @type {number | Error} */ (7),
        /** @param {string} name @param {any} payload */
        emit(name, payload){
            events.emit(name, payload);
        },
        /** @param {string} text */
        write(text){
            journal.write(Level.INFO, 'test', text);
        },
        /** One closed frame, so that a reader has a frame and a phase to read. */
        frame(){
            profiler.beginFrame();
            profiler.begin('turn', 'guest');
            profiler.end('turn');
            const closed = profiler.endFrame();
            own[0] = journal.rejected();
            registry.sample();
            return closed;
        },
        on: (/** @type {string} */ name, /** @type {(payload: any) => void} */ handler)=>
            events.on(name, handler),
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
            memory: ()=>(audioShared ? { table: new ArrayBuffer(64) } : ring.memory),
            format: ()=>({ sampleRate: 48000, channels: 2 }),
        },
        /** How many times the log's memory has been asked for. */
        memories: 0,
        log: {
            memory(){
                app.memories++;
                return { journal: journal.memory(), tables: registry.describe() };
            },
            /** @param {number} count */
            recent: count=>journal.recent(count),
            /** @param {number} since @param {number} limit */
            drain: (since, limit)=>journal.drain(since, limit),
            /** @param {'error' | 'warn' | 'info'} level @param {string} category @param {string} text */
            write: (level, category, text)=>journal.write(
                { error: Level.ERROR, warn: Level.WARN, info: Level.INFO }[level], category, text),
            /** @param {number} count */
            frames: count=>profiler.frames(count),
            /** @param {number} worst */
            profile: worst=>profiler.snapshot(worst),
            setDefaultLevel: (/** @type {any} */ level)=>{
                app.levels.push(level);
            },
        },
        /** How the account was asked for, in order, so the page's words can be checked. */
        profiled: /** @type {any[]} */ ([]),
        guestProfile: {
            available: ()=>true,
            instructionStats: ()=>({ counters: { RETIRED: 3 }, opcodes: [] }),
            /** @param {{ keepCode?: boolean }} [how] */
            start(how){
                app.profiled.push({ start: how ?? null });
                return true;
            },
            read: ()=>({ entries: [{ address: 0x401000, instructions: 12, hits: 12 }],
                dropped: 1 }),
            stop(){
                app.profiled.push({ stop: true });
            },
        },
        registry: ()=>({ toJSON: ()=>({ HKLM: {} }) }),
        systemLibraries: ()=>['KERNEL32.dll', 'D3D9.dll'],
        session: { export: ()=>[{ path: 'C:\\a.txt', bytes: Uint8Array.of(1, 2) }] },
        files: {
            /** @param {string} path */
            list: path=>[{ name: 'a.txt', path: path + '\\a.txt', directory: false, size: 2,
                modified: 0 }],
            /** @param {string} path */
            read: path=>(path === 'C:\\a.txt' ? Uint8Array.of(1, 2) : new Uint8Array(0)),
        },
        diagnostics: ()=>[
            { name: 'cpu', metrics: { instructions: 5, ring: ()=>0,
                tail: Uint8Array.of(1, 2), texels: new Uint8Array(4096),
                handle: Object.create({ inherited: 1 }), pages: new Map([[1, 2]]) } },
            { name: 'audio', metrics: { tracks: 2 } },
        ],
        debug: {
            hook: ()=>({}),
            /** @param {number} address @param {number} length */
            read: (address, length)=>Uint8Array.from({ length }, (_, i)=>(address + i) & 0xff),
            modules: ()=>[{ name: 'GAME.EXE', base: 0x400000, size: 0x1000 }],
        },
        dispose(){
            app.disposed++;
        },
    };
    return app;
}

/** The GPU the worker would open, and the canvas it would draw into. */
function fakeGpu(){
    /** @type {Map<string, (event: any) => void>} */
    const listeners = new Map();
    /** @type {(info: { reason: string, message: string }) => void} */
    let lose = ()=>{};
    const device = {
        queue: { submit(){} },
        lost: new Promise(resolve=>{
            lose = resolve;
        }),
        /** @param {string} type @param {(event: any) => void} handler */
        addEventListener(type, handler){
            listeners.set(type, handler);
        },
        createCommandEncoder: ()=>({ copyTextureToTexture(){}, finish(){} }),
    };
    /** @type {any[]} */
    const requested = [];
    return {
        /** What the device was asked for, one descriptor per requestDevice. */
        requested,
        /** What the device would report: an error the engine did not catch. @param {string} message */
        fail(message){
            listeners.get('uncapturederror')?.({ error: { message } });
        },
        /** The device lost, as a driver reset or a GPU process crash loses it. */
        lose: (/** @type {string} */ reason, /** @type {string} */ message)=>lose({ reason, message }),
        gpu: {
            requestAdapter: async()=>({
                features: new Set(['texture-compression-bc', 'depth-clip-control', 'shader-f16']),
                info: { vendor: 'fake', architecture: '', description: 'a stand-in' },
                requestDevice: async(/** @type {any} */ descriptor)=>{
                    requested.push(descriptor);
                    return device;
                },
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
 * The log keeper, served over a real `MessageChannel` so the test sees what
 * the page posted to it. A page no longer holds a reader, so this is the
 * stand-in that proves every read went to the keeper rather than being decoded
 * where the caller is.
 */
function openTestKeeper(){
    const channel = new MessageChannel();
    /** @type {any[]} */
    const sent = [];
    const serving = serveKeeper(/** @type {any} */ (channel.port2), { intervalMs: 5 });
    const port = {
        /** @param {any} message @param {any[]} [handOver] */
        postMessage(message, handOver){
            sent.push(message);
            channel.port1.postMessage(message, handOver ?? []);
        },
        get onmessage(){ return channel.port1.onmessage; },
        set onmessage(handler){ channel.port1.onmessage = handler; },
    };
    return { port, sent, close(){
        serving.close();
        channel.port1.close();
        channel.port2.close();
    } };
}

/**
 * @param {Partial<import('./messages.js').StartOptions>} [options]
 * @param {{ threaded?: boolean, now?: () => number, gpu?: any,
 *     journal?: { capacity?: number, shared?: boolean }, audioShared?: boolean,
 *     duringBuild?: (app: any) => void }} [deps]
 */
async function connect(options = {}, { journal, audioShared, duringBuild, ...deps } = {}){
    const channel = new MessageChannel();
    const app = fakeApp({ ...journal, audioShared });
    const keeper = openTestKeeper();
    const { gpu, canvas, screen, fail, lose, requested } = fakeGpu();
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
            // What `buildApp` does for real: emit before the `start` request's
            // answer is even posted back, let alone before a page's `on()` for
            // that name can run.
            duringBuild?.(app);
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
    opened.push(()=>keeper.close());
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
        keeper: keeper.port,
    });
    return { remote, app, worker, canvas, keeper, built: ()=>built, gpuFails: fail, gpuLost: lose,
        requested };
}

test('a bundle kept on this device crosses as its file and is read from it a range at a time',
    async()=>{
        const bytes = Uint8Array.from({ length: 4096 }, (_, index)=>index & 0xff);
        const { built } = await connect({
            bundle: { file: new Blob([bytes]), id: 'local', store: null },
        });
        const { bundle } = built();
        assert.deepEqual([...await bundle.fetch(1000, 4)], [232, 233, 234, 235]);
        await assert.rejects(()=>bundle.fetch(4090, 10), /past the bundle's end/);
    });

test('start rebuilds on the worker what could not cross: fetch, device, watch, storage', async()=>{
    const { remote, built } = await connect({
        watch: { libraries: { 'storm.dll': null, 'game.dll': [268] }, strings: [0] },
        storage: { files: [{ path: 'C:\\Install\\setup.exe', bytes: Uint8Array.of(9) }] },
        device: { fog: false, maxDraws: 3 },
    });
    const options = built();
    assert.equal(typeof options.bundle.fetch, 'function');
    assert.equal(options.bundle.id, 'b');
    // The canvas and its context cross to the presenter the app makes, and the
    // frame account stays here; there is no ready-made copy function any more.
    assert.equal(typeof options.device.canvas, 'object');
    assert.equal(typeof options.device.screen.configure, 'function');
    assert.equal(typeof options.device.onFrame, 'function');
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

test('the device is asked for the features the engine draws with that the adapter has',
    async()=>{
        // Block compression keeps a program's DXT art compressed; depth clip
        // control lets a Direct3D 10 rasterizer state turn depth clipping off.
        // A feature the adapter has and nothing here uses is not asked for.
        const { remote, requested } = await connect();
        assert.deepEqual(requested.map(descriptor=>descriptor.requiredFeatures),
            [['texture-compression-bc', 'depth-clip-control']]);
        await remote.dispose();
    });

test('the sound output\'s storage crosses once, at start', async()=>{
    const { remote, app } = await connect();
    const memory = remote.audio.memory();
    assert.equal(memory.samples.byteLength, 64);
    assert.deepEqual(remote.audio.format(), { sampleRate: 48000, channels: 2 });
    assert.equal(app.attached.length, 1);
    assert.deepEqual(app.attached[0].options, { listen: false });
    await remote.dispose();
});

test('the sound output\'s shape follows the engine\'s own backend, not a fixed contract', async()=>{
    // The whole surface a page has for its worklet is `memory()`/`format()`;
    // there is no `ring()` here for a caller to fall back to (docs/core/api.md's
    // `audio.memory()` row) -- a caller written against the engine backend's
    // `{ control, samples }` shape breaks outright on a page that turns out
    // to have shared memory, rather than reading something merely wrong.
    const shared = await connect({}, { audioShared: true });
    assert.deepEqual(Object.keys(shared.remote.audio.memory()), ['table']);
    assert.equal(typeof (/** @type {any} */ (shared.remote.audio)).ring, 'undefined',
        'no ring() to fall back to -- a stale caller must be updated, not silently degraded');
    await shared.remote.dispose();

    const unshared = await connect({}, { audioShared: false });
    assert.deepEqual(Object.keys(unshared.remote.audio.memory()).sort(), ['control', 'samples']);
    await unshared.remote.dispose();
});

test('without shared memory the mix is posted to the worklet, which says what it played',
    async()=>{
        const worklet = new MessageChannel();
        opened.push(()=>worklet.port2.close());
        const { remote, app, built } = await connect(
            { audio: { drained: true, sampleRate: 48000, port: worklet.port1 } },
            { audioShared: false });
        assert.equal(built().audio.port, undefined, 'the port is the worker\'s, not the engine\'s');
        assert.equal(built().audio.drained, true);
        /** @type {any} */
        const chunk = await new Promise(done=>{
            worklet.port2.onmessage = event=>done(event.data);
        });
        assert.equal(chunk.at, 0);
        assert.deepEqual([...chunk.frames], [1, -1, 2, -2, 3, -3]);
        worklet.port2.postMessage({ played: 2, blocks: 1, starvedBlocks: 0, starvedFrames: 0 });
        await until(()=>app.ring.consumed() === 2);
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

test('with concurrency input crosses through the ring, is read at a turn boundary without'
    + ' a yield, and keeps its order with what is posted after it', async()=>{
    const { remote, app } = await connect({ concurrency: 2 });
    const pacing = app.options.pacing;
    assert.ok(app.options.inbound === undefined, 'the ring is the host\'s, not the app\'s');
    remote.input.send({ kind: 'key', code: 'KeyA', down: true });
    remote.input.send({ kind: 'pointerMove', x: 10, y: 20, dx: 1, dy: -1 });
    await settled();
    assert.deepEqual(app.sent, [], 'nothing was posted: the event loop delivered nothing');
    assert.equal(pacing.yield({ suspended: 0, fetching: 0, idlers: 0, spun: 0 }), null,
        'a turn boundary reads the ring and goes straight on');
    assert.deepEqual(app.sent, [
        { kind: 'key', code: 'KeyA', down: true },
        { kind: 'pointerMove', x: 10, y: 20, dx: 1, dy: -1 },
    ]);
    remote.input.send({ kind: 'key', code: 'KeyB', down: true });
    await remote.diagnostics();
    assert.deepEqual(app.sent.at(-1), { kind: 'key', code: 'KeyB', down: true },
        'a request posted after an input event finds it read first');
    assert.equal(pacing.counts().yields, 0);
    await remote.dispose();
});

test('attaching with pointerLock asks the page canvas for the lock on a click', async()=>{
    const { remote } = await connect();
    let asked = 0;
    const viewport = { ...fakeViewport({ width: 320, height: 240 }),
        requestPointerLock: ()=>{ asked++; } };
    remote.input.attach(viewport, { pointerLock: true });
    viewport.fire('pointerdown', { clientX: 1, clientY: 1, button: 0, pointerId: 1 });
    assert.equal(asked, 1);
    remote.input.detach();
    remote.input.attach(viewport);
    viewport.fire('pointerdown', { clientX: 1, clientY: 1, button: 0, pointerId: 1 });
    assert.equal(asked, 1);
    await remote.dispose();
});

test('a DOM event captured on the page is scaled by the frame the worker presented', async()=>{
    const { remote, app, built } = await connect();
    // The page's canvas is 320x240 on screen and keeps saying so; the worker
    // presents at 640x480, which is the space a click lives in.
    const viewport = fakeViewport({ width: 320, height: 240 });
    remote.input.attach(viewport);
    // The presenter reports a frame that reached the canvas; this is what the
    // presenter calls when the size changed or the run's first frame arrived.
    built().device.onFrame({ width: 640, height: 480, presented: 1, resized: true });
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

test('an event the engine emitted before the start answer still reaches a handler '
    + 'registered on the returned controller, in order with a live one', async()=>{
    // The documented pattern is `const app = await createApp(...); app.on(...)`,
    // and `createRemoteApp`'s own `start` request has already resolved by the
    // time this function returns -- so a name `buildApp` emits before that,
    // like `hooks-bound`, is always "early" from the controller's point of view.
    const { remote, app } = await connect({}, {
        duringBuild: theApp=>theApp.emit('hooks-bound', { bound: ['idSIMD.dotPlaneDrawVert'],
            refused: [] }),
    });
    /** @type {any[]} */
    const seen = [];
    remote.on('hooks-bound', (/** @type {any} */ payload)=>seen.push(payload));
    await settled();
    assert.deepEqual(seen, [{ bound: ['idSIMD.dotPlaneDrawVert'], refused: [] }],
        'the construction-time emission was not lost');

    app.emit('hooks-bound', { bound: [], refused: ['idSIMD.cmpLTBit'] });
    await settled();
    assert.deepEqual(seen[1], { bound: [], refused: ['idSIMD.cmpLTBit'] },
        'and a live one after still arrives, in order behind the replayed one');
    await remote.dispose();
});

test('a handler registered after a first one already claimed a name only sees '
    + 'what is live from then on', async()=>{
    const { remote, app } = await connect({}, {
        duringBuild: theApp=>theApp.emit('hooks-bound', { bound: ['idSIMD.dotPlaneDrawVert'],
            refused: [] }),
    });
    /** @type {any[]} */
    const early = [];
    remote.on('hooks-bound', (/** @type {any} */ payload)=>early.push(payload));
    await settled();
    /** @type {any[]} */
    const late = [];
    remote.on('hooks-bound', (/** @type {any} */ payload)=>late.push(payload));
    await settled();
    app.emit('hooks-bound', { bound: [], refused: [] });
    await settled();

    assert.equal(early.length, 2, 'the first subscriber got the replay, then the live one');
    assert.deepEqual(late, [{ bound: [], refused: [] }],
        'the later subscriber to the same name got no replay, only the live one');
    await remote.dispose();
});

test('run answers with the exit code and what the exit left behind', async()=>{
    const { remote } = await connect({ collectOnExit: true });
    assert.throws(()=>remote.session.export(), /not exited/);
    assert.equal(await remote.run({ maxTurns: 5 }), 7);
    assert.deepEqual(remote.session.export(), [{ path: 'C:\\a.txt', bytes: Uint8Array.of(1, 2) }]);
    assert.deepEqual(remote.registry().toJSON(), { HKLM: {} });
    assert.deepEqual(remote.systemLibraries(), ['KERNEL32.dll', 'D3D9.dll'],
        'and what an installer\'s output is sorted against');
    await remote.dispose();
});

test('an exit\'s volume is moved to the page rather than copied', async()=>{
    // An installer's volume is a gigabyte and more, and a copy of it on each
    // side of the port is more than a page need have room for.
    const { remote, app } = await connect({ collectOnExit: true });
    // Two files over one buffer, as a copy between them leaves them: moved once.
    const one = Uint8Array.of(1, 2, 3);
    const written = [{ path: 'C:\\a.txt', bytes: one.subarray(0, 2) },
        { path: 'C:\\b.txt', bytes: one.subarray(2) }];
    app.session.export = ()=>written;
    assert.equal(await remote.run(), 7);
    assert.deepEqual(remote.session.export().map((/** @type {any} */ file)=>[...file.bytes]),
        [[1, 2], [3]]);
    assert.equal(one.buffer.byteLength, 0, 'the worker holds none of it');
    await assert.rejects(remote.files.read('C:\\a.txt'), /went to the page with the exit/);
    await remote.dispose();
});

test('a message crosses as it is: a buffer that cannot move is copied, a refusal goes as JSON',
    async()=>{
        const { port1, port2 } = new MessageChannel();
        opened.push(()=>{
            port1.close();
            port2.close();
        });
        /** @type {any[]} */
        const seen = [];
        port2.onmessage = ({ data })=>seen.push(data);
        const bytes = Uint8Array.of(1, 2, 3);
        assert.equal(postAsItIs(port1, { bytes }, [bytes.buffer]), true);
        assert.equal(bytes.byteLength, 0, 'moved');
        // A wasm memory's buffer is not detachable.
        const memory = new WebAssembly.Memory({ initial: 1 });
        new Uint8Array(memory.buffer).set([4, 5]);
        assert.equal(postAsItIs(port1, { view: new Uint8Array(memory.buffer, 0, 2) },
            [memory.buffer]), false);
        assert.equal(memory.buffer.byteLength, 65536, 'still the memory\'s');
        assert.equal(postAsItIs(port1, { kept: 1, dropped: ()=>1 }), false);
        await settled();
        assert.deepEqual(seen[0].bytes, Uint8Array.of(1, 2, 3));
        assert.deepEqual([...seen[1].view], [4, 5]);
        assert.deepEqual(seen[2], { kept: 1 });
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

test('the page reads the journal, the frames and the phases through the keeper', async()=>{
    const { remote, app, keeper } = await connect();
    app.write('one');
    app.write('two');
    app.frame();
    // A write is picked up by the keeper's next poll; wait for it rather than
    // guessing a cadence under whatever load the suite is running at.
    await until(async()=>(await remote.log.recent(1)).length === 1);
    const crossed = remote.traffic().request;

    assert.equal(remote.log.reading(), 'shared');
    // A read is a request to a worker now, not a decode on this thread: that
    // is the whole point, and it is why every one of them is a promise.
    const recent = remote.log.recent(1);
    assert.ok(recent instanceof Promise, 'the page holds no reader of its own');
    assert.deepEqual((await recent).map((/** @type {any} */ r)=>r.text), ['two']);
    const first = await remote.log.drain(0, 10);
    assert.deepEqual(first.records.map((/** @type {any} */ r)=>r.text), ['one', 'two']);
    assert.equal(first.next, 2);
    assert.deepEqual(await remote.log.drain(first.next, 10),
        { records: [], from: 2, next: 2, lost: 0 });

    const frames = await remote.log.frames(8);
    assert.equal(frames.length, 1, 'the frame the engine closed, read out of its table');
    const profile = await remote.log.profile(1);
    assert.equal(profile.frames, 1);
    assert.ok(profile.phases.some((/** @type {any} */ phase)=>phase.name === 'turn'),
        'and the phase inside it');
    assert.deepEqual(await remote.log.counters('log'), { rejected: 0 });
    assert.equal((await remote.log.table('log', 'frames'))?.written, 1);
    assert.equal(typeof await remote.log.word(0), 'string');
    assert.deepEqual(await remote.log.threads(), []);
    assert.deepEqual(await remote.log.guestByModule(), {});
    assert.deepEqual(await remote.log.stats(),
        { written: 2, capacity: 4096, lost: 0, rejected: 0 });
    assert.ok(remote.log.memory()?.journal instanceof SharedArrayBuffer);

    assert.equal(remote.traffic().request, crossed,
        'not one of those reads was a message to the engine');

    // The writer's gate is the one thing that still crosses: a level says what
    // is kept, and only the thread that keeps it can be told.
    await remote.log.setDefaultLevel('debug');
    assert.deepEqual(app.levels, ['debug']);
    assert.equal(remote.traffic().request, crossed + 1);

    // The keeper was handed the block and asked; the page decoded nothing.
    assert.ok(keeper.sent.some((/** @type {any} */ message)=>message.type === 'attach'));
    assert.ok(keeper.sent.some((/** @type {any} */ message)=>
        message.type === 'request' && message.name === 'recent'));
    await remote.dispose();
});

test('the log block is handed over once, in the answer that starts the program', async()=>{
    const { remote, app } = await connect();
    app.write('one');
    app.frame();
    await settled();
    await remote.log.recent(10);
    await remote.log.frames(8);
    await remote.log.profile(1);
    await remote.log.guestByModule();
    await remote.log.threads();
    await remote.run();
    assert.equal(app.memories, 1, 'asked for at start and never again');
    await remote.dispose();
    await remote.dispose().catch(()=>{});
    assert.equal(app.memories, 1);
});

test('a rebuilt process hands the keeper the next block', async()=>{
    const { remote, worker, keeper } = await connect();
    // A second machine's journal, as the engine publishes it after a swap: a
    // fresh block whose sequences continue the one the parent left behind.
    const child = createJournal({ now: ()=>0, shared: true, capacity: 64, sequenceBase: 5 });
    child.write(Level.INFO, 'child', 'after the swap');
    worker.onmessage?.({ data: { type: 'log-memory',
        memory: { journal: child.memory() }, sequenceBase: 5 } });
    await settled();

    const attach = keeper.sent.filter((/** @type {any} */ message)=>
        message.type === 'attach').pop();
    assert.equal(attach.sequenceBase, 5, 'the base the child begins at reached the keeper');
    assert.ok(attach.memory.journal instanceof SharedArrayBuffer);
    const records = await remote.log.drain(5, 10);
    assert.deepEqual(records.records.map((/** @type {any} */ r)=>r.text), ['after the swap'],
        'and the keeper reads the new block from there');
    await remote.dispose();
});

test('without shared memory the keeper is fed by relay, and a table does not cross', async()=>{
    const { remote, app } = await connect({ log: { capacity: 8 } },
        { journal: { shared: false, capacity: 6 } });
    assert.equal(remote.log.reading(), 'requests');
    assert.equal(remote.log.memory(), null);
    for (let at = 0; at < 4; at++)
    {
        app.write(`${at}`);
    }
    await remote.run();
    const first = await remote.log.drain(0, 100);
    assert.equal(first.lost, 0);
    assert.equal(first.next, 4);
    assert.deepEqual(first.records.map((/** @type {any} */ r)=>r.text),
        ['0', '1', '2', '3']);
    app.frame();
    assert.equal((await remote.log.frames(8)).length, 1, 'a frame still answers, by request');
    assert.equal((await remote.log.profile(1)).frames, 1);
    assert.deepEqual(await remote.log.counters('log'), { rejected: 0 });
    assert.equal(await remote.log.table('log', 'frames'), null, 'a table cannot cross as a copy');
    assert.equal(await remote.log.word(3), '#3');

    const stats = await remote.log.stats();
    assert.equal(stats.written, 4, 'everything the keeper was relayed');
    assert.equal(stats.capacity, 8);
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

test('the page lists and reads the volume while the program runs', async()=>{
    const { remote } = await connect();
    assert.deepEqual(await remote.files.list('C:'),
        [{ name: 'a.txt', path: 'C:\\a.txt', directory: false, size: 2, modified: 0 }]);
    assert.deepEqual(await remote.files.read('C:\\a.txt'), Uint8Array.of(1, 2));
    await remote.dispose();
});

test('the page reads guest memory and the images mapped while the program runs', async()=>{
    const { remote } = await connect();
    assert.deepEqual(await remote.debug.read(0x401000, 4), Uint8Array.of(0, 1, 2, 3));
    assert.deepEqual(await remote.debug.modules(),
        [{ name: 'GAME.EXE', base: 0x400000, size: 0x1000 }]);
    await remote.dispose();
});

test('the page starts, reads and stops the account of where the guest ran', async()=>{
    const { remote, app } = await connect();

    assert.equal(await remote.guestProfile.available(), true);
    assert.equal(await remote.guestProfile.start({ keepCode: true }), true);
    assert.deepEqual(await remote.guestProfile.read(), {
        entries: [{ address: 0x401000, instructions: 12, hits: 12 }],
        dropped: 1,
    });
    await remote.guestProfile.stop();
    assert.deepEqual((await remote.guestProfile.instructionStats()).counters, { RETIRED: 3 });

    // keepCode is the whole reason the options object crosses: without it the
    // account is the compiler's blocks rather than the interpreter's steps.
    assert.deepEqual(app.profiled, [{ start: { keepCode: true } }, { stop: true }]);
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
    assert.equal(typeof built().device.onFrame, 'function');
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

test('a worker runs turns back to back and yields for something pending or on its clock', async()=>{
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
    const nothing = { suspended: 0, fetching: 0, idlers: 0, spun: 0 };
    assert.equal(pacing.yield(nothing), null);
    assert.equal(pacing.yield(nothing), null);
    await pacing.yield({ ...nothing, suspended: 1 });
    await pacing.yield({ ...nothing, fetching: 1 });
    await pacing.yield({ ...nothing, spun: 1 });
    assert.equal(yields, 3, 'a call suspended, a range in flight and a turn that retired '
        + 'nothing each yield at once');
    assert.equal(pacing.yield({ ...nothing, idlers: 1 }), null,
        "a caller on the guest's own queue looks again without the host");
    signalled = true;
    await pacing.yield(nothing);
    assert.equal(yields, 4, 'the page posted something');
    signalled = false;
    assert.equal(pacing.yield(nothing), null);
    now += WORKER_YIELD_MS - 1;
    assert.equal(pacing.yield(nothing), null, 'the interval is not up');
    now += 1;
    await pacing.yield(nothing);
    assert.equal(yields, 5, 'the interval is up');
    assert.equal(pacing.yield(nothing), null, 'and the clock was reset');
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
    const nothing = { suspended: 0, fetching: 0, idlers: 0, spun: 0 };
    let clock = 0;
    const now = ()=>clock;

    const same = await connect({}, { now });
    assert.equal(same.built().pacing.yield(nothing), null);
    clock = PAGE_YIELD_MS;
    assert.ok(same.built().pacing.yield(nothing),
        "a port on the same thread yields on the page's clock");
    await same.remote.dispose();

    clock = 0;
    const looks = await connect({}, { threaded: true, now });
    clock = PAGE_YIELD_MS;
    assert.equal(looks.built().pacing.yield(nothing), null,
        "a worker holds its thread past the page's interval");
    clock = WORKER_YIELD_MS;
    assert.ok(looks.built().pacing.yield(nothing), 'and yields on its own');
    await looks.remote.dispose();

    const { remote, built } = await connect({ pacing: 'event' }, { threaded: true });
    const pacing = built().pacing;
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

test('what the GPU device refuses goes into the journal, a repeat counted rather than written',
    async()=>{
        const { remote, gpuFails } = await connect();
        const REFUSED = 'Failed to allocate texture.' + String.fromCharCode(10)
            + ' - While calling CreateTexture([TextureDescriptor "target"])';
        // A failing frame cycles through a few messages; each is counted on its own.
        for (let i = 0; i < 300; i++)
        {
            gpuFails(REFUSED);
            gpuFails('another');
        }
        await until(async()=>(await remote.log.recent(8)).length >= 4);
        const records = (await remote.log.recent(8)).filter((/** @type {any} */ r)=>r.category === 'gpu');
        const flat = 'Failed to allocate texture.'
            + ' - While calling CreateTexture([TextureDescriptor "target"])';
        assert.deepEqual(records.map((/** @type {any} */ r)=>[r.levelName, r.text]), [
            ['error', flat],
            ['error', 'another'],
            ['error', `${flat} (x256)`],
            ['error', 'another (x256)'],
        ]);
    });

test('a GPU device lost says so in the journal, where a frozen picture is looked into', async()=>{
    // Nothing else notices: the counters keep counting frames that reach a
    // device that is gone. A device destroyed at the end of a run is its end,
    // not a loss, and is not reported.
    const { remote, gpuLost } = await connect();
    gpuLost('unknown', 'the GPU process exited');
    await until(async()=>(await remote.log.recent(8)).some((/** @type {any} */ r)=>
        r.category === 'gpu'));
    const records = (await remote.log.recent(8)).filter((/** @type {any} */ r)=>r.category === 'gpu');
    assert.deepEqual(records.map((/** @type {any} */ r)=>[r.levelName, r.text]), [
        ['error', 'the GPU device was lost (unknown): the GPU process exited -- nothing drawn'
            + ' from here on reaches the screen'],
    ]);
});

test('a network named at start is opened by the worker and closed with the run', async()=>{
    // A transport is a WebSocket and callbacks, neither of which crosses a
    // port, so the worker imports the client by the URL the page named and
    // opens it; the engine never imports the networking package itself.
    const module = new URL('./fake-relay.test.mjs', import.meta.url).href;
    const { remote, built } = await connect({
        network: { module, url: 'wss://play/relay', room: 'b' },
    });
    const fake = await import(module);
    assert.equal(fake.opened.length, 1);
    assert.deepEqual(fake.opened[0].options,
        { url: 'wss://play/relay', room: 'b', token: undefined });
    assert.equal(built().win32.network, fake.opened[0], 'handed to createApp as win32.network');
    await remote.dispose();
    assert.equal(fake.opened[0].disposed, 1, 'closed with the run');
});
