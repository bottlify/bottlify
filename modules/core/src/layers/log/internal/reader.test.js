/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { Level, createJournal } from './journal.js';
import { createLogReader } from './reader.js';
import { createMetrics } from './metrics.js';
import { FRAME_MIRROR } from './profiler.js';
import { logModule } from '../module.js';

const setup = (/** @type {any} */ options = {})=>{
    const journal = createJournal({ now: ()=>0, ...options });
    const reader = createLogReader({ memory: { journal: journal.memory() } });
    return { journal, reader };
};

/**
 * Writes a layer's mirrored counters by the column a frame's row names them
 * by, so a test names the figure it means and the layout decides the order.
 *
 * @param {any} api @param {string} layer
 */
const mirroredBy = (api, layer)=>{
    const wanted = FRAME_MIRROR.filter(entry=>entry.layer === layer);
    const row = api.metrics.counters(layer, wanted.map(entry=>entry.counter));
    /** @param {string} column @param {number} value */
    return (column, value)=>{
        const at = wanted.findIndex(entry=>entry.column === column);
        assert.notEqual(at, -1, `no frame column named "${column}"`);
        row[at] = value;
    };
};

test('a subscriber is handed its topics at its level and nothing else', ()=>{
    const { journal, reader } = setup({ level: Level.TRACE });
    /** @type {string[]} */
    const cpu = [];
    /** @type {string[]} */
    const loud = [];
    /** @type {string[]} */
    const everything = [];
    reader.subscribe('cpu', records=>cpu.push(...records.map(r=>r.text)));
    reader.subscribe(['cpu', 'loader'], records=>loud.push(...records.map(r=>r.text)),
        { level: Level.WARN });
    reader.subscribe('*', records=>everything.push(...records.map(r=>r.text)));

    journal.write(Level.INFO, 'cpu', 'cpu info');
    journal.write(Level.WARN, 'cpu', 'cpu warn');
    journal.write(Level.ERROR, 'loader', 'loader error');
    journal.write(Level.DEBUG, 'audio', 'audio debug');
    reader.poll();

    assert.deepEqual(cpu, ['cpu info', 'cpu warn']);
    assert.deepEqual(loud, ['cpu warn', 'loader error']);
    assert.deepEqual(everything, ['cpu info', 'cpu warn', 'loader error', 'audio debug']);
});

test('a subscriber removed is not called again, and a poll with nothing new calls nobody', ()=>{
    const { journal, reader } = setup();
    let calls = 0;
    const remove = reader.subscribe('*', ()=>{ calls++; });
    journal.write(Level.INFO, 'cpu', 'one');
    reader.poll();
    reader.poll();
    remove();
    journal.write(Level.INFO, 'cpu', 'two');
    reader.poll();
    assert.equal(calls, 1);
});

test('the reader answers recent and drain the way the engine used to', ()=>{
    const { journal, reader } = setup({ capacity: 4 });
    for (let at = 0; at < 10; at++)
    {
        journal.write(Level.INFO, 'boot', '{0}', at);
    }
    assert.deepEqual(reader.recent(2).map(r=>r.text), ['8', '9']);
    const caught = reader.drain(0);
    assert.equal(caught.from, 6);
    assert.equal(caught.next, 10);
    assert.equal(caught.lost, 6);
    assert.deepEqual(caught.records.map(r=>r.text), ['6', '7', '8', '9']);
    assert.deepEqual(reader.drain(caught.next).records, []);
});

test('a poll that fell behind counts exactly what it missed', ()=>{
    const { journal, reader } = setup({ capacity: 4 });
    /** @type {number[]} */
    const seen = [];
    reader.subscribe('*', records=>seen.push(...records.map(r=>Number(r.text))));
    journal.write(Level.INFO, 'boot', '{0}', 0);
    reader.poll();
    for (let at = 1; at < 11; at++)
    {
        journal.write(Level.INFO, 'boot', '{0}', at);
    }
    const result = reader.poll();
    assert.deepEqual(seen, [0, 7, 8, 9, 10]);
    assert.equal(result.lost, 6, 'one to six were written over');
    assert.equal(reader.lost(), 6);
});

test('a layer\'s counters and tables are read from the same memory the layer writes', ()=>{
    const journal = createJournal({ now: ()=>0 });
    const metrics = createMetrics();
    const kernel = metrics.counters('kernel', ['turns']);
    const threads = metrics.table('kernel', 'threads', { rows: 8, columns: ['name', 'state'] });
    const reader = createLogReader({
        memory: { journal: journal.memory(), tables: metrics.describe() },
    });

    kernel[0] = 42;
    threads.set(0, 0, journal.intern('main'));
    threads.set(0, 1, 2);
    threads.used(1);

    assert.deepEqual(reader.counters('kernel'), { turns: 42 });
    const rows = reader.table('kernel', 'threads')?.all() ?? [];
    assert.equal(rows.length, 1);
    assert.equal(reader.word(rows[0].name), 'main');
    assert.equal(reader.table('audio', 'nothing'), null);
    assert.deepEqual(reader.counters('audio'), {});
});

test('a reader on another thread drains the journal without the engine answering anything',
    async()=>{
        const journal = createJournal({ now: ()=>0 });
        const worker = new Worker(`
            const { parentPort, workerData } = require('node:worker_threads');
            import(workerData.url).then(({ createLogReader })=>{
                const reader = createLogReader({ memory: workerData.memory });
                const seen = [];
                reader.subscribe('cpu', records=>seen.push(...records.map(r=>r.text)));
                const pump = ()=>{
                    reader.poll();
                    if (seen.length < 3) { setTimeout(pump, 1); }
                    else { parentPort.postMessage(seen); }
                };
                pump();
            });
        `, {
            eval: true,
            workerData: { url: new URL('./reader.js', import.meta.url).href,
                memory: { journal: journal.memory() } },
        });
        const seen = new Promise(resolve=>worker.once('message', resolve));
        journal.write(Level.INFO, 'cpu', 'slice {0}', 1);
        journal.write(Level.INFO, 'audio', 'not for this subscriber');
        journal.write(Level.INFO, 'cpu', 'slice {0}', 2);
        journal.write(Level.INFO, 'cpu', 'slice {0}', 3);
        assert.deepEqual(await seen, ['slice 1', 'slice 2', 'slice 3']);
        await worker.terminate();
    });

test('the reader names where the guest ran from the kernel\'s pages and the memory\'s regions',
    ()=>{
        const journal = createJournal({ now: ()=>0 });
        const metrics = createMetrics({ shared: false });
        const pages = metrics.table('kernel', 'pages', { rows: 0x100, columns: ['instructions'] });
        const regions = metrics.table('memory', 'regions',
            { rows: 8, columns: ['name', 'base', 'size', 'access'] });
        regions.set(0, 0, journal.intern('game.exe'));
        regions.set(0, 1, 0x400000);
        regions.set(0, 2, 0x200000);
        regions.set(1, 0, journal.intern('storm.dll'));
        regions.set(1, 1, 0x800000);
        regions.set(1, 2, 0x100000);
        regions.used(2);
        pages.values[0x40] = 300;
        pages.values[0x41] = 200;
        pages.values[0x80] = 400;
        pages.values[0xf0] = 50;
        pages.values[0xff] = 5;

        const reader = createLogReader({
            memory: { journal: journal.memory(), tables: metrics.describe() },
        });
        assert.deepEqual(reader.guestByModule(),
            { 'game.exe': 500, 'storm.dll': 400, unmapped: 50, elsewhere: 5 },
            'the last row is an address outside guest memory, whatever region sits at its index');
        assert.deepEqual(Object.keys(reader.guestByModule()),
            ['game.exe', 'storm.dll', 'unmapped', 'elsewhere'], 'heaviest first');
    });

test('frames and the profile are read from the tables the profiler publishes into', async()=>{
    let time = 0;
    const api = await logModule.create({ now: ()=>time, wallClock: ()=>time, shared: false });
    const reader = createLogReader({ memory: api.memory() });

    api.beginFrame();
    api.begin('turn');
    api.begin('slice', 'guest');
    time = 8;
    api.end('slice', { instructions: 1000 });
    time = 10;
    api.end('turn');
    api.note('instructions', 1000);
    time = 12;
    api.endFrame();

    const [frame] = reader.frames();
    assert.equal(frame.index, 0);
    assert.equal(frame.ms, 12);
    assert.equal(frame.byKind.guest, 8);
    assert.equal(frame.byKind.host, 2);
    assert.deepEqual(frame.longest, { name: 'turn', ms: 10 });
    assert.deepEqual(frame.longestGuest, { ms: 8, instructions: 1000, rate: 125_000 },
        'with the rate the slice managed, which is what a stall is told by');
    assert.deepEqual(frame.notes, { instructions: 1000 });

    const profile = reader.profile();
    assert.equal(profile.frames, 1);
    assert.deepEqual(profile.phases.map(row=>[row.name, row.kind, row.selfMs]),
        [['slice', 'guest', 8], ['turn', 'host', 2]]);
    assert.equal(profile.hostShare, 2 / 12);
    assert.deepEqual(reader.counters('log'), { rejected: 0, unbalancedPhases: 0 });
    await logModule.dispose();
});

test('a frame says what the program did and what it cost us, without a second run', async()=>{
    let time = 0;
    const api = await logModule.create({ now: ()=>time, wallClock: ()=>time, shared: false });
    const cpu = mirroredBy(api, 'cpu');
    const kernel = mirroredBy(api, 'kernel');
    const memory = mirroredBy(api, 'memory');
    const regions = api.metrics.table('memory', 'regions',
        { rows: 4, columns: ['name', 'base', 'size', 'access'] });
    regions.set(0, 0, api.intern('Storm.dll'));
    regions.set(0, 1, 0x6f00000);
    regions.set(0, 2, 0x100000);
    regions.used(1);
    const reader = createLogReader({ memory: api.memory() });

    /**
     * @param {number} ms @param {number} retired @param {number} interpreted
     * @param {Object} [extra]
     * @param {number} [extra.stretches]  Interpreter entries, cumulative.
     * @param {number} [extra.worst]      Steps of the frame's heaviest stretch.
     * @param {number} [extra.at]         Where that stretch began.
     * @param {number} [extra.written]    Bytes the host wrote, cumulative.
     * @param {string} [extra.writer]     Which call wrote most of them.
     * @param {number} [extra.writerBytes]
     */
    const frame = (ms, retired, interpreted, extra = {})=>{
        api.beginFrame();
        api.begin('slice', 'guest');
        time += ms;
        api.end('slice', { instructions: retired });
        cpu('retired', retired);
        cpu('interpretedSteps', interpreted);
        cpu('interpretedDispatches', extra.stretches ?? 0);
        cpu('hostWrittenBytes', extra.written ?? 0);
        cpu('interpretedWorst', extra.worst ?? 0);
        cpu('interpretedAt', extra.at ?? 0);
        kernel('thread', api.intern('main'));
        kernel('threadInstructions', retired);
        kernel('threadAt', 0x6f01000);
        memory('writer', extra.writer === undefined ? -1 : api.intern(extra.writer));
        memory('writerBytes', extra.writerBytes ?? 0);
        api.endFrame();
    };

    // Three frames of a counter that only ever grows, read as three frames.
    frame(10, 1_000_000, 500, { stretches: 10, written: 1000 });
    frame(10, 3_000_000, 1500, { stretches: 40, written: 5000,
        writer: 'LockRect', writerBytes: 2000 });
    frame(100, 3_500_000, 60_000, { stretches: 140, written: 900_000,
        worst: 48_000, at: 0x6f02000, writer: 'CreateTexture', writerBytes: 700_000 });
    const frames = reader.frames();
    assert.equal(frames.length, 3);
    assert.deepEqual(frames.map(one=>one.instructions), [0, 2_000_000, 500_000],
        'the oldest row has nothing to subtract from and claims nothing');
    assert.deepEqual(frames.map(one=>one.counters.interpretedSteps), [0, 1000, 58_500]);
    assert.equal(frames[2].counters.interpretedSteps > frames[1].counters.interpretedSteps * 50,
        true, 'the interpret burst is in the frame that had it');
    assert.equal(frames[2].instructions / frames[2].ms < frames[1].instructions / frames[1].ms,
        true, 'and that frame ran the program slower than the one before');
    assert.equal(frames[2].counters.x87TagLost, 0, 'a counter nothing wrote reads as nothing');
    assert.deepEqual(frames[2].thread,
        { name: 'main', instructions: 3_500_000, at: 0x6f01000, module: 'Storm.dll' });
    // The two things a count alone could not say: where the interpreter ran,
    // and which of our own calls put the bytes into the guest.
    assert.deepEqual(frames[2].interpreted, {
        steps: 58_500, compiledSteps: 0, stretches: 100, perStretch: 585,
        worst: 48_000, at: 0x6f02000, module: 'Storm.dll',
        // Every reason reported, and nothing left absent because no layer
        // moved it: a field that only appears when it is interesting cannot
        // be read as an answer when it is missing.
        reasons: {
            noCode: { stretches: 0, steps: 0 },
            noEntry: { stretches: 0, steps: 0 },
            nearPageEnd: { stretches: 0, steps: 0 },
            differentState: { stretches: 0, steps: 0 },
        },
        belowThreshold: 0, compileDeferred: 0, entryAfterPageWalk: 0,
        lostToWrites: { modules: 0, hotness: 0 },
    });
    assert.deepEqual(frames[2].wrote,
        { bytes: 895_000, busiest: 'CreateTexture', busiestBytes: 700_000 });
    assert.equal(frames[0].wrote.busiest, null,
        'a frame nobody wrote in names no writer');
    assert.equal(frames[2].longestGuest.rate, 35_000_000,
        'the worst slice of the frame, in instructions a second');

    // A counter that went backwards -- a machine restarted under the reader --
    // is reported as no work rather than as negative work.
    frame(10, 10, 0);
    assert.equal(reader.frames().at(-1)?.instructions, 0);
    await logModule.dispose();
});

test('a frame says why the interpreter ran, as the step the counters took in it', async()=>{
    let time = 0;
    const api = await logModule.create({ now: ()=>time, wallClock: ()=>time, shared: false });
    const cpu = mirroredBy(api, 'cpu');
    const reader = createLogReader({ memory: api.memory() });

    /**
     * The interpreter's reason counters as a frame's row carries them, and
     * what each of them is worth cumulatively after the second frame. Named
     * one by one on purpose: a list derived from the layout would still pass
     * with a column dropped from it, and the point of this test is that none
     * of these can go missing again unnoticed.
     *
     * @type {[string, number, number][]}
     */
    const reasons = [
        ['interpNoCode', 100, 900],
        ['interpNoEntry', 20, 25],
        ['interpNearPageEnd', 7, 11],
        ['interpDifferentState', 3, 3],
        ['interpNoCodeSteps', 4_000, 44_000],
        ['interpNoEntrySteps', 500, 700],
        ['interpNearPageEndSteps', 60, 100],
        ['interpDifferentStateSteps', 9, 9],
        ['interpBelowThreshold', 80, 800],
        ['interpEntryAfterPageWalk', 1_000, 1_400],
        ['modulesLostToWrites', 2, 5],
        ['hotnessLostToWrites', 6, 6],
        ['compiledSteps', 1_000_000, 1_040_000],
        // Left where it was on purpose: a reason the frame did not take has to
        // report nothing, not report missing.
        ['interpCompileDeferred', 0, 0],
    ];

    /** @param {number} ms @param {boolean} second  Which of the two readings to write. */
    const frame = (ms, second)=>{
        api.beginFrame();
        api.begin('slice', 'guest');
        time += ms;
        api.end('slice', { instructions: 1000 });
        for (const [column, before, after] of reasons)
        {
            cpu(column, second ? after : before);
        }
        api.endFrame();
    };
    frame(10, false);
    frame(60, true);

    const frames = reader.frames();
    assert.equal(frames.length, 2);
    for (const [column, before, after] of reasons)
    {
        assert.equal(frames[1].counters[column], after - before,
            `${column} as the step this frame took, not as the run's total`);
        assert.equal(frames[0].counters[column], 0,
            `${column} claims nothing in a frame with nothing before it`);
    }

    // And as a reader reads them: the four reasons with the steps each one
    // interpreted, which is what a bare step count could never say.
    assert.deepEqual(frames[1].interpreted.reasons, {
        noCode: { stretches: 800, steps: 40_000 },
        noEntry: { stretches: 5, steps: 200 },
        nearPageEnd: { stretches: 4, steps: 40 },
        differentState: { stretches: 0, steps: 0 },
    });
    assert.equal(frames[1].interpreted.belowThreshold, 720);
    assert.equal(frames[1].interpreted.compileDeferred, 0,
        'a reason nothing moved is zero rather than absent');
    assert.equal(frames[1].interpreted.entryAfterPageWalk, 400);
    assert.deepEqual(frames[1].interpreted.lostToWrites, { modules: 3, hotness: 0 });
    assert.equal(frames[1].interpreted.compiledSteps, 40_000,
        'beside the interpreted steps, so the two can be compared in one frame');
    await logModule.dispose();
});

test('the writers table reads back as names, heaviest first', async()=>{
    const api = await logModule.create({ now: ()=>0, wallClock: ()=>0, shared: false });
    const table = api.metrics.table('memory', 'writers',
        { rows: 4, columns: ['name', 'bytes', 'writes'] });
    /**
     * @param {number} row @param {string} name
     * @param {number} bytes @param {number} writes
     */
    const put = (row, name, bytes, writes)=>
    {
        table.set(row, 0, api.intern(name));
        table.set(row, 1, bytes);
        table.set(row, 2, writes);
    };
    put(0, '<no host call>', 0, 0);
    put(1, 'LockRect', 900, 3);
    put(2, 'WriteFile', 9000, 1);
    table.used(3);

    const reader = createLogReader({ memory: api.memory() });
    assert.deepEqual(reader.writers(), [
        { name: 'WriteFile', bytes: 9000, writes: 1 },
        { name: 'LockRect', bytes: 900, writes: 3 },
    ], 'a row nobody wrote through is not a writer');
    await logModule.dispose();
});

test('a build whose memory layer publishes nothing has no writers rather than a throw', async()=>{
    const api = await logModule.create({ now: ()=>0, wallClock: ()=>0, shared: false });
    assert.deepEqual(createLogReader({ memory: api.memory() }).writers(), []);
    await logModule.dispose();
});
