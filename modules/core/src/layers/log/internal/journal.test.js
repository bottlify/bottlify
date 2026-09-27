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

    const revision = journal.revision();
    journal.setLevel('loader', Level.TRACE);
    assert.equal(journal.enabled('loader', Level.DEBUG), true);
    assert.equal(journal.revision(), revision + 1, 'a level change moves the revision');
    journal.setDefaultLevel(Level.ERROR);
    assert.equal(journal.enabled('memory', Level.WARN), false);
    assert.equal(journal.revision(), revision + 2, 'and so does the default');
    const cell = journal.revisionCell();
    assert.equal(cell[0], journal.revision(), 'the cell holds the revision');
    journal.setLevel('cpu', Level.OFF);
    assert.equal(cell[0], revision + 3, 'and moves with it, the same cell');
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

test('the journal holds a bounded amount however much is written', ()=>{
    // The whole reason the ring exists. A program that runs for an hour reports
    // a great many things, and a journal that kept them all would be a leak
    // that scales with how well the engine works -- worst in exactly the runs
    // worth journalling. What survives is the tail, and the drop is counted.
    const journal = createJournal({ capacity: 64, now: ()=>0 });

    for (let at = 0; at < 100_000; at++)
    {
        journal.write(Level.INFO, `category-${at % 8}`, '{0}', at);
    }

    assert.equal(journal.recent(1_000_000).length, 64, 'the ring is the whole memory');
    assert.equal(journal.diagnostics().capacity, 64, 'and it never grew');
    assert.equal(journal.diagnostics().written, 100_000, 'while still counting everything');

    // Two maps could grow without the ring doing so. One entry per template,
    // whatever the arguments, and a category level only where one was set.
    assert.equal(journal.diagnostics().templates, 1);
    assert.deepEqual(journal.diagnostics().categories, {});

    // Last, since a drain that finds itself lapped writes a line of its own.
    assert.equal(journal.drain(0, 1_000_000).records.length, 64);
});

test('a drain reads forward and says where to resume', ()=>{
    // What a live view needs, as against the tail: asking for "the last twenty"
    // over and over either repeats what is already on screen or loses what
    // happened in between.
    const journal = createJournal({ capacity: 64, now: ()=>0 });
    journal.write(Level.INFO, 'boot', 'one');
    journal.write(Level.INFO, 'boot', 'two');

    const first = journal.drain(0);
    assert.deepEqual(first.records.map((/** @type {any} */ record)=>record.message), ['one', 'two']);
    assert.equal(first.next, 2);

    assert.deepEqual(journal.drain(first.next).records, [], 'nothing new yet');

    journal.write(Level.INFO, 'boot', 'three');
    const second = journal.drain(first.next);
    assert.deepEqual(second.records.map((/** @type {any} */ record)=>record.message), ['three']);
    assert.equal(second.next, 3);
});

test('a journal that took over continues the sequence a reader is holding', ()=>{
    // A machine rebuilt on a child's image gets a fresh block. A page draining
    // it with the cursor it held from the one before keeps reading, rather than
    // falling past the end of a block that restarted at zero.
    const journal = createJournal({ now: ()=>0, sequenceBase: 100 });
    journal.write(Level.INFO, 'boot', 'child');

    const read = journal.drain(100);
    assert.equal(read.from, 100, 'the block begins where the reader stopped');
    assert.equal(read.next, 101);
    assert.equal(read.lost, 0, 'and none of it is reported as a gap');
    assert.deepEqual(read.records.map((/** @type {any} */ record)=>record.message), ['child']);

    journal.flush();
    assert.equal(journal.diagnostics().lost, 0,
        'the sequences before the block are not records the sink missed');
});

test('a reader that falls behind the ring is told where it actually resumes', ()=>{
    // A gap reported rather than papered over: a terminal that stopped reading
    // for a second must not be shown the wrong hundred lines as though they
    // followed the ones it already has.
    const journal = createJournal({ capacity: 4, now: ()=>0 });
    for (let at = 0; at < 10; at++)
    {
        journal.write(Level.INFO, 'boot', '{0}', at);
    }

    const caught = journal.drain(0);
    assert.equal(caught.from, 6, 'the first six were lapped before anyone read them');
    assert.equal(caught.records.length, 4);
    assert.equal(caught.next, 10);
    assert.equal(caught.lost, 6, 'and the reader is told exactly how many');
});

test('a drain counts what was written over since its last read, and says so in the log', ()=>{
    // A reader told "0 lost" over a sequence with holes in it has been lied
    // to. The count is exact per read; the line in the log is for whoever
    // reads it without the count, and names whose flood it is.
    const { journal, time } = journalWith({ capacity: 4 });
    for (let at = 0; at < 3; at++)
    {
        journal.write(Level.INFO, 'boot', '{0}', at);
    }
    const first = journal.drain(0);
    assert.equal(first.lost, 0);
    assert.equal(journal.diagnostics().written, 3, 'nothing to say about a read that kept up');

    for (let at = 3; at < 13; at++)
    {
        journal.write(Level.INFO, at < 5 ? 'boot' : 'call.com', '{0}', at);
    }
    const lapped = journal.drain(first.next);
    assert.equal(lapped.from, 9);
    assert.equal(lapped.lost, 6, 'sequences three to eight are gone');
    assert.deepEqual(lapped.records.map((/** @type {any} */ record)=>record.text),
        ['9', '10', '11', '12'], 'the line about it comes after this read, not inside it');
    const [line] = journal.drain(lapped.next).records;
    assert.equal(line.category, 'log');
    assert.equal(line.level, Level.WARN);
    assert.equal(line.text,
        '6 records were written over before they were read; most of the ring is call.com');

    // Lapped again within the second: counted exactly, but not another line
    // yet -- the line itself must not be what floods the ring.
    for (let at = 14; at < 30; at++)
    {
        journal.write(Level.INFO, 'call.com', '{0}', at);
    }
    time.step(500);
    const again = journal.drain(14);
    assert.equal(again.lost, 12);
    assert.equal(journal.recent(1).at(0)?.category, 'call.com', 'no line yet');
    for (let at = 30; at < 40; at++)
    {
        journal.write(Level.INFO, 'call.com', '{0}', at);
    }
    time.step(500);
    const later = journal.drain(again.next);
    assert.equal(later.lost, 6);
    assert.equal(journal.recent(1).at(0)?.text,
        '18 records were written over before they were read; most of the ring is call.com',
        'a second on, one line carrying everything lost since the last');
});

test('a drain honours its limit and resumes exactly where it stopped', ()=>{
    const journal = createJournal({ capacity: 64, now: ()=>0 });
    for (let at = 0; at < 10; at++)
    {
        journal.write(Level.INFO, 'boot', '{0}', at);
    }

    const page = journal.drain(0, 4);
    assert.equal(page.records.length, 4);
    assert.equal(page.next, 4);
    assert.equal(journal.drain(page.next, 4).records.length, 4);
    assert.equal(journal.drain(8, 4).records.length, 2, 'and runs out rather than wrapping');
});
