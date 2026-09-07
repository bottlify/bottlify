/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Level, createJournal, toLevel } from './journal.js';

/** A clock the test steps by hand; nothing here reads a real one. */
function clock(){
    let time = 0;
    return { now: ()=>time, step: (/** @type {number} */ by)=>{ time += by; } };
}

/**
 * @param {any} [options]
 * @returns {any}
 */
function journalWith(options){
    const time = clock();
    const journal = createJournal({ now: time.now, ...options });
    return { journal, time };
}

test('a category keeps what its level admits and nothing quieter', ()=>{
    const { journal } = journalWith({ level: Level.INFO, categories: { cpu: Level.TRACE } });

    journal.write(Level.DEBUG, 'loader', 'not kept');
    journal.write(Level.INFO, 'loader', 'kept');
    journal.write(Level.TRACE, 'cpu', 'kept too');
    journal.write(Level.OFF, 'cpu', 'never kept at all');

    assert.deepEqual(journal.recent().map((/** @type {any} */ r)=>r.text),
        ['kept', 'kept too']);
    assert.equal(journal.diagnostics().rejected, 2);
    assert.equal(journal.enabled('loader', Level.DEBUG), false);
    assert.equal(journal.enabled('cpu', Level.DEBUG), true);

    journal.setLevel('loader', Level.TRACE);
    assert.equal(journal.enabled('loader', Level.DEBUG), true);
    journal.setDefaultLevel(Level.ERROR);
    assert.equal(journal.enabled('memory', Level.WARN), false);
});

test('the message stays a template until someone reads it', ()=>{
    const { journal } = journalWith({});

    journal.write(Level.INFO, 'loader', 'mapped {0} at {1:x}', 'game.exe', 0x400000);
    const record = journal.recent()[0];

    assert.equal(record.message, 'mapped {0} at {1:x}', 'stored uninterpolated');
    assert.equal(record.text, 'mapped game.exe at 0x400000');
    assert.deepEqual(record.args, ['game.exe', 0x400000]);
    assert.equal(record.levelName, 'info');
});

test('an argument the template does not name is appended, not dropped', ()=>{
    const { journal } = journalWith({});

    journal.write(Level.INFO, 'cpu', 'fault at {0:x}', 0xdeadbeef, 'write', 4);
    journal.write(Level.INFO, 'cpu', 'nothing to say {7}');

    const [fault, missing] = journal.recent();
    assert.equal(fault.text, 'fault at 0xdeadbeef write 4');
    assert.equal(missing.text, 'nothing to say {7}', 'a placeholder with no argument is left be');
});

test('timestamps come from the injected clock, ordering from the sequence', ()=>{
    const { journal, time } = journalWith({});

    journal.write(Level.INFO, 'cpu', 'first');
    time.step(17);
    journal.write(Level.INFO, 'cpu', 'second');

    const [first, second] = journal.recent();
    assert.deepEqual([first.time, second.time], [0, 17]);
    assert.equal(second.sequence, first.sequence + 1);
});

test('a sink sees each record once, in detached copies', ()=>{
    const { journal } = journalWith({ capacity: 4 });
    /** @type {any[][]} */
    const batches = [];
    const remove = journal.addSink((/** @type {any[]} */ records)=>batches.push(records));

    journal.write(Level.INFO, 'cpu', 'one');
    journal.write(Level.INFO, 'cpu', 'two');
    assert.equal(journal.flush(), 2);
    assert.equal(journal.flush(), 0, 'a flush with nothing new delivers nothing');

    // Whatever the sink kept must survive the writer lapping the slot it came
    // from -- the point of handing out copies rather than the ring's own rows.
    const kept = batches[0][0];
    for (let index = 0; index < 8; index++)
    {
        journal.write(Level.INFO, 'cpu', 'filler {0}', index);
    }
    assert.equal(kept.text, 'one');

    remove();
    journal.flush();
    assert.equal(batches.length, 1, 'a removed sink is not called again');
});

test('records lapped before a sink saw them are counted, not hidden', ()=>{
    const { journal } = journalWith({ capacity: 4 });
    journal.addSink(()=>{});

    for (let index = 0; index < 10; index++)
    {
        journal.write(Level.INFO, 'cpu', 'line {0}', index);
    }
    assert.equal(journal.flush(), 4, 'only what the ring still holds is delivered');
    assert.equal(journal.diagnostics().lost, 6);
});

test('recent() reads the tail without disturbing the flush position', ()=>{
    const { journal } = journalWith({ capacity: 8 });
    /** @type {any[]} */
    const seen = [];
    journal.addSink((/** @type {any[]} */ records)=>seen.push(...records));

    for (let index = 0; index < 5; index++)
    {
        journal.write(Level.INFO, 'cpu', 'line {0}', index);
    }
    assert.deepEqual(journal.recent(2).map((/** @type {any} */ r)=>r.text),
        ['line 3', 'line 4']);
    assert.equal(journal.flush(), 5, 'the snapshot consumed nothing');
    assert.equal(seen.length, 5);
});

test('the summary by template counts what a grep would have to count', ()=>{
    const { journal } = journalWith({ capacity: 4 });

    for (let index = 0; index < 6; index++)
    {
        journal.write(Level.WARN, 'gdi', 'unimplemented {0}', `Api${index}`);
    }
    journal.write(Level.INFO, 'cpu', 'started');

    const [first, second] = journal.templates();
    assert.deepEqual(
        [first.message, first.count, first.category, first.level],
        ['unimplemented {0}', 6, 'gdi', Level.WARN],
        'the template survives the records being lapped');
    assert.equal(second.count, 1);
});

test('a level may be written as a name, and anything else is refused', ()=>{
    assert.equal(toLevel('debug'), Level.DEBUG);
    assert.equal(toLevel('OFF'), Level.OFF);
    assert.equal(toLevel(Level.WARN), Level.WARN);
    assert.throws(()=>toLevel('loud'), /not a log level/);
    assert.throws(()=>toLevel(9), /not a log level/);
});
