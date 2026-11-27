/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The log keeper, on a thread that did not write the journal.
 *
 * The engine only ever writes into its ring; the keeper is what drains it
 * before it laps, keeps the history a live view reads back, hands batches to
 * its subscribers and answers the reads the page makes. A replacement does not
 * restart it: it is handed the next block, and a cursor taken from the one
 * before still resolves.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createJournal, Level } from '../layers/log/internal/journal.js';
import { createLogModule } from '../layers/log/module.js';
import { BUCKET_CAP, SAMPLE_COLUMNS, createSampleTable, creditSample }
    from '../layers/cpu/internal/samples.js';
import { THREAD_COLUMNS } from '../layers/kernel/internal/threads.js';
import { REGION_COLUMNS } from '../layers/memory/module.js';
import { publishFigures } from '../layers/graphics/figures.js';

/**
 * The keeper under `worker_threads`, driven the way a page drives it. The
 * worker script adapts `parentPort` to the port shape `serveKeeper` wants, so
 * the real keeper code runs in a real worker, exactly as `shared-journal.test`
 * runs its reader on another thread.
 *
 * @param {Object} [options]
 */
function openKeeper(options = {}){
    const url = new URL('./keeper.js', import.meta.url).href;
    const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.url).then(({ serveKeeper }) => {
            let handler = null;
            const port = {
                postMessage: message => parentPort.postMessage(message),
                set onmessage(fn){ handler = fn; },
                get onmessage(){ return handler; },
            };
            serveKeeper(port, workerData.options);
            parentPort.on('message', data => {
                if (handler) handler({ data });
            });
        });
    `, { eval: true, workerData: { url, options } });

    /** @type {any[]} */
    const messages = [];
    /** @type {{ check: (message: any) => boolean, resolve: (message: any) => void }[]} */
    const waiting = [];
    worker.on('message', message=>{
        messages.push(message);
        for (let at = waiting.length - 1; at >= 0; at--)
        {
            if (waiting[at].check(message))
            {
                waiting[at].resolve(message);
                waiting.splice(at, 1);
            }
        }
    });

    let ids = 0;
    /** @param {any} message */
    const send = message=>worker.postMessage(message);
    /** @param {(message: any) => boolean} check */
    const next = check=>{
        const hit = messages.find(check);
        if (hit)
        {
            return Promise.resolve(hit);
        }
        return new Promise(resolve=>{
            waiting.push({ check, resolve });
        });
    };
    /** @param {string} name @param {unknown[]} [args] */
    const ask = async(name, args = [])=>{
        const id = ++ids;
        send({ type: 'request', id, name, args });
        const answer = await next(/** @param {any} message */ message=>
            message.type === 'answer' && message.id === id);
        if (answer.error)
        {
            throw Object.assign(new Error(answer.error.message), { error: answer.error });
        }
        return answer.value;
    };
    /**
     * Runs one poll on the keeper and resolves once it has finished, so a test
     * says when the block is read instead of waiting for a timer to land.
     */
    const poll = async()=>{
        const id = ++ids;
        send({ type: 'poll', id });
        await next(/** @param {any} message */ message=>
            message.type === 'polled' && message.id === id);
    };

    return { send, ask, poll, next, messages, stop: ()=>worker.terminate() };
}

test('the keeper answers reads and hands subscribers their batches', async t=>{
    // No timer: every poll below is the test's own, so nothing here races a
    // clock under load.
    const keeper = openKeeper({ intervalMs: 0, capacity: 64 });
    t.after(()=>keeper.stop());

    const journal = createJournal({ now: ()=>0, capacity: 64 });
    journal.write(Level.INFO, 'boot', 'one');
    journal.write(Level.WARN, 'call.cpu', 'two');
    journal.write(Level.INFO, 'boot', 'three');
    keeper.send({ type: 'attach', memory: { journal: journal.memory() }, sequenceBase: 0 });
    await keeper.poll();

    assert.deepEqual((await keeper.ask('recent', [10])).map(/** @param {any} r */ r=>r.text),
        ['one', 'two', 'three']);
    const first = await keeper.ask('drain', [0, 10]);
    assert.equal(first.next, 3);
    assert.equal(first.lost, 0);
    assert.equal(await keeper.ask('lost'), 0);
    assert.deepEqual(await keeper.ask('drain', [first.next, 10]),
        { records: [], from: 3, next: 3, lost: 0 });

    // A subscriber asks for one topic at its own level; a record is filtered
    // out at write time or at the subscriber, never sent to the wrong one.
    keeper.send({ type: 'subscribe', id: 7, topics: ['call.cpu'], level: Level.TRACE });
    // A request travels behind the subscribe, so its answer proves the
    // subscription is in place before anything is written for it: a poll that
    // ran in between would otherwise take the records and leave the
    // subscriber waiting for a batch that never comes.
    await keeper.ask('lost');
    journal.write(Level.INFO, 'boot', 'four');
    journal.write(Level.INFO, 'call.cpu', 'five');
    await keeper.poll();
    const batch = await keeper.next(/** @param {any} m */ m=>
        m.type === 'records' && m.id === 7);
    assert.deepEqual(batch.records.map(/** @param {any} r */ r=>r.text), ['five']);

    // Every topic at warning and above: two records are written, one arrives.
    keeper.send({ type: 'subscribe', id: 8, topics: '*', level: Level.WARN });
    await keeper.ask('lost');
    journal.write(Level.INFO, 'boot', 'six');
    journal.write(Level.ERROR, 'boot', 'seven');
    await keeper.poll();
    const starred = await keeper.next(/** @param {any} m */ m=>
        m.type === 'records' && m.id === 8);
    assert.deepEqual(starred.records.map(/** @param {any} r */ r=>r.text), ['seven']);
    assert.equal(keeper.messages.filter(/** @param {any} m */ m=>
        m.type === 'records' && m.id === 8).length, 1, 'one batch, not one message a record');

    // Unsubscribing stops the batches; the keeper's history is unaffected.
    keeper.send({ type: 'unsubscribe', id: 7 });
    const before = keeper.messages.length;
    journal.write(Level.INFO, 'call.cpu', 'eight');
    await keeper.poll();
    assert.ok((await keeper.ask('recent', [10]))
        .some(/** @param {any} r */ r=>r.text === 'eight'), 'the history kept the last write');
    assert.equal(keeper.messages.slice(before).filter(/** @param {any} m */ m=>
        m.type === 'records' && m.id === 7).length, 0, 'nothing was delivered to it');
});

test('a read catches the current block up, so a tail since the last poll is not missed', async t=>{
    const keeper = openKeeper({ intervalMs: 0, capacity: 64 });
    t.after(()=>keeper.stop());

    // The block's own ring is larger than the keeper's mirror, as an engine sized
    // for a capture of a call area leaves it.
    const journal = createJournal({ now: ()=>0, capacity: 512 });
    journal.write(Level.INFO, 'boot', 'one');
    keeper.send({ type: 'attach', memory: { journal: journal.memory() }, sequenceBase: 0 });
    await keeper.poll();

    // The program writes its last lines and exits; no poll runs for them. A
    // read is the last look, so it must see them without a timer.
    journal.write(Level.INFO, 'boot', 'crash-a');
    journal.write(Level.ERROR, 'boot', 'crash-b');

    const tail = await keeper.ask('recent', [10]);
    assert.deepEqual(tail.map(/** @param {any} r */ r=>r.text),
        ['one', 'crash-a', 'crash-b']);

    const drained = await keeper.ask('drain', [0, 10]);
    assert.deepEqual(drained.records.map(/** @param {any} r */ r=>r.text),
        ['one', 'crash-a', 'crash-b']);
    assert.equal(drained.lost, 0);

    // A tail longer than the mirror is the block's own: a capture of a
    // few frames of a call area outruns any live view's history.
    for (let i = 0; i < 200; i++)
    {
        journal.write(Level.INFO, 'boot', `line-${i}`);
    }
    const whole = await keeper.ask('recent', [1000]);
    assert.ok(whole.length > 64, `${whole.length} records, more than the mirror holds`);
    assert.equal(whole[whole.length - 1].text, 'line-199');
});

test('a second block attached continues the first, and a cursor from it resolves', async t=>{
    const keeper = openKeeper({ intervalMs: 0, capacity: 64 });
    t.after(()=>keeper.stop());

    const first = createJournal({ now: ()=>0, capacity: 64 });
    first.write(Level.INFO, 'boot', 'one');
    keeper.send({ type: 'attach', memory: { journal: first.memory() }, sequenceBase: 0 });
    await keeper.poll();
    /** A cursor a live view would be holding before the handover. */
    const cursor = 0;
    const base = first.diagnostics().written;

    const second = createJournal({ now: ()=>0, capacity: 64,
        sequenceBase: base });
    second.write(Level.INFO, 'child', 'eight');
    second.write(Level.INFO, 'child', 'nine');
    assert.equal(base, 1);

    keeper.send({ type: 'attach', memory: { journal: second.memory() }, sequenceBase: base });
    await keeper.poll();

    const across = await keeper.ask('drain', [cursor, 100]);
    assert.deepEqual(across.records.map(/** @param {any} r */ r=>[r.sequence, r.text]),
        [[0, 'one'], [1, 'eight'], [2, 'nine']],
        'the history spans the two blocks in sequence order');
    assert.equal(across.lost, 0, 'a cursor from the first block is not a gap');
    assert.equal(await keeper.ask('lost'), 0);

    // Reading from where the second block begins returns only its records.
    const onlySecond = await keeper.ask('drain', [base, 100]);
    assert.deepEqual(onlySecond.records.map(/** @param {any} r */ r=>r.text), ['eight', 'nine']);
    assert.equal(onlySecond.lost, 0);
});

test('a live view is answered by the keeper from what the layers published', async t=>{
    // What the overlay follows: published by each layer where it keeps the
    // figure, the frame's samplers run once, and read back on the keeper's
    // thread -- the engine's side is asked nothing.
    const keeper = openKeeper({ intervalMs: 0 });
    t.after(()=>keeper.stop());
    const logModule = createLogModule();
    let time = 0;
    const log = await logModule.create({ now: ()=>time, wallClock: ()=>time });
    t.after(()=>logModule.dispose());
    const { metrics } = log;

    const cpu = metrics.counters('cpu', ['running', 'instructions']);
    cpu.set(0, 1, 5_000_000);
    const samples = createSampleTable(metrics.table('cpu', 'samples',
        { rows: BUCKET_CAP, columns: SAMPLE_COLUMNS }));
    creditSample(samples, 0x401000, 300);
    creditSample(samples, 0x402000, 900);
    creditSample(samples, 0x401010, 200);

    const threads = metrics.table('kernel', 'threads', { rows: 4, columns: THREAD_COLUMNS });
    threads.set(0, THREAD_COLUMNS.indexOf('name'), log.intern('main'));
    threads.set(0, THREAD_COLUMNS.indexOf('instructions'), 4_000_000);
    threads.set(0, THREAD_COLUMNS.indexOf('state'), 1);
    threads.use(1);
    const regions = metrics.table('memory', 'regions', { rows: 4, columns: REGION_COLUMNS });
    regions.set(0, 0, log.intern('game.exe'));
    regions.set(0, 1, 0x400000);
    regions.set(0, 2, 0x10000);
    regions.use(1);
    const hooks = metrics.table('bridge', 'hooks',
        { rows: 4, columns: ['name', 'calls', 'hookNs'] });
    hooks.set(0, 0, log.intern('memcpy'));
    hooks.set(0, 1, 40);
    hooks.set(0, 2, 1.5e6);
    hooks.use(1);

    let device = /** @type {any} */ (null);
    metrics.onFrame(publishFigures({
        metrics, intern: log.intern,
        shown: ()=>({ count: 12, by: { 'd3d9 target': 12 } }),
        figures: ()=>device,
        worker: ()=>null,
    }));
    log.beginFrame();
    log.begin('trap');
    time = 3;
    log.end('trap');
    time = 4;
    log.endFrame();
    keeper.send({ type: 'attach', memory: log.memory(), sequenceBase: 0 });
    await keeper.poll();

    const first = await keeper.ask('live');
    assert.equal(first.instructions, 5_000_000);
    assert.deepEqual(first.phases.map(/** @param {any} p */ p=>[p.name, p.selfMs]), [['trap', 3]]);
    assert.deepEqual(first.samples, [{ address: 0x402000, instructions: 900 },
        { address: 0x401000, instructions: 500 }], 'ranked by the keeper, by bucket');
    assert.deepEqual(first.threads, [{ id: 0, name: 'main', instructions: 4_000_000,
        state: 'running' }]);
    assert.deepEqual(first.regions, [{ name: 'game.exe', base: 0x400000, size: 0x10000 }]);
    assert.deepEqual(first.hooks, [{ name: 'memcpy', calls: 40, ms: 1.5 }]);
    assert.equal(first.graphics.shown, 12);
    assert.deepEqual(first.graphics.shownBy, { 'd3d9 target': 12 });
    assert.equal(first.graphics.device, null, 'no device said anything: not measured, not zero');
    assert.equal(first.graphics.lastFrame, null);
    assert.equal(first.graphics.worker, null);

    device = { draws: 300, gpuFrames: 10, gpuMs: 42, last: { index: 9, draws: 30,
        offscreenDraws: 2, offscreenTargets: 1, clears: 1, clearColor: 0xff000000,
        viewportX: 0, viewportY: 0, viewportWidth: 800, viewportHeight: 600,
        targetWidth: 800, targetHeight: 600 } };
    log.beginFrame();
    log.endFrame();
    const second = await keeper.ask('live');
    assert.deepEqual(second.graphics.device, { draws: 300, gpuFrames: 10, gpuMs: 42 });
    assert.deepEqual(second.graphics.lastFrame, device.last);
});
