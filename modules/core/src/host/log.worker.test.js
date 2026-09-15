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

/** A wait for everything queued to be delivered. */
const settled = (ms = 30)=>new Promise(resolve=>setTimeout(resolve, ms));

/** Waits for a condition to hold, so no test depends on a poll landing in time. */
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
        await settled(5);
    }
};

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

    return { send, ask, next, messages, stop: ()=>worker.terminate() };
}

test('the keeper answers reads and hands subscribers their batches', async t=>{
    const keeper = openKeeper({ intervalMs: 5, capacity: 64 });
    t.after(()=>keeper.stop());

    const journal = createJournal({ now: ()=>0, shared: true, capacity: 64 });
    journal.write(Level.INFO, 'boot', 'one');
    journal.write(Level.WARN, 'call.cpu', 'two');
    journal.write(Level.INFO, 'boot', 'three');
    keeper.send({ type: 'attach', memory: { journal: journal.memory() }, sequenceBase: 0 });

    // The attach and the request travel in order, so the keeper has polled the
    // block before it answers -- no clock is being raced here.
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
    journal.write(Level.INFO, 'boot', 'four');
    journal.write(Level.INFO, 'call.cpu', 'five');
    const batch = await keeper.next(/** @param {any} m */ m=>
        m.type === 'records' && m.id === 7);
    assert.deepEqual(batch.records.map(/** @param {any} r */ r=>r.text), ['five']);

    // Every topic at warning and above: two records are written, one arrives.
    keeper.send({ type: 'subscribe', id: 8, topics: '*', level: Level.WARN });
    journal.write(Level.INFO, 'boot', 'six');
    journal.write(Level.ERROR, 'boot', 'seven');
    const starred = await keeper.next(/** @param {any} m */ m=>
        m.type === 'records' && m.id === 8);
    assert.deepEqual(starred.records.map(/** @param {any} r */ r=>r.text), ['seven']);
    assert.equal(keeper.messages.filter(/** @param {any} m */ m=>
        m.type === 'records' && m.id === 8).length, 1, 'one batch, not one message a record');

    // Unsubscribing stops the batches; the keeper's history is unaffected.
    keeper.send({ type: 'unsubscribe', id: 7 });
    const before = keeper.messages.length;
    journal.write(Level.INFO, 'call.cpu', 'eight');
    await until(async()=>(await keeper.ask('recent', [10]))
        .some(/** @param {any} r */ r=>r.text === 'eight'));
    assert.equal(keeper.messages.slice(before).filter(/** @param {any} m */ m=>
        m.type === 'records' && m.id === 7).length, 0, 'nothing was delivered to it');
});

test('a second block attached continues the first, and a cursor from it resolves', async t=>{
    const keeper = openKeeper({ intervalMs: 5, capacity: 64 });
    t.after(()=>keeper.stop());

    const first = createJournal({ now: ()=>0, shared: true, capacity: 64 });
    first.write(Level.INFO, 'boot', 'one');
    keeper.send({ type: 'attach', memory: { journal: first.memory() }, sequenceBase: 0 });
    /** A cursor a live view would be holding before the handover. */
    const cursor = 0;
    const base = first.diagnostics().written;

    const second = createJournal({ now: ()=>0, shared: true, capacity: 64,
        sequenceBase: base });
    second.write(Level.INFO, 'child', 'eight');
    second.write(Level.INFO, 'child', 'nine');
    assert.equal(base, 1);

    keeper.send({ type: 'attach', memory: { journal: second.memory() }, sequenceBase: base });

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
