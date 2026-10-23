/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_WORD, createEventWords } from './event-words.js';
import { EVENT_TAG, MIRROR, createEventMirror } from './event-mirror.js';
import { createHandleTable } from './handles.js';
import { createSyncObjects } from './sync.js';

const BASE = 0x1000;
const TABLE = 0x10000;

/** Whether the host keeps the word at `at`. */
const hostKeeps = (/** @type {Map<number, number>} */ words, /** @type {number} */ at)=>
    ((words.get(at) ?? 0) & EVENT_WORD.HOST) === EVENT_WORD.HOST;

/** A guest memory of words, and the kernel's events over it. */
function machine(){
    /** @type {Map<number, number>} */
    const words = new Map();
    const memory = {
        readU32: (/** @type {number} */ at)=>words.get(at) ?? 0,
        /** @param {number} at @param {number} expected @param {number} value */
        compareExchangeU32: (at, expected, value)=>{
            const was = words.get(at) ?? 0;
            if (was === expected >>> 0)
            {
                words.set(at, value >>> 0);
            }
            return was;
        },
    };
    const events = createEventWords(memory);
    /** @type {any[]} */
    const blocked = [];
    const scheduler = {
        block: (/** @type {any} */ thread)=>void blocked.push(thread),
        wake(){}, addTimer: ()=>1, removeTimer(){},
    };
    const sync = createSyncObjects({ scheduler, eventChanged(){}, eventWords: events });
    return { words, events, sync };
}

test('an event made before there is room gets its word once there is, in its state, the guest\'s',
    ()=>{
        const { words, events, sync } = machine();
        const auto = /** @type {any} */ (sync.createEvent({ signalled: true }));
        const manual = /** @type {any} */ (sync.createEvent({ manualReset: true }));
        assert.equal(auto.word, undefined);
        assert.equal(manual.word, undefined);
        events.attach(BASE, 4);
        assert.equal(auto.word, BASE);
        assert.equal(words.get(BASE), EVENT_WORD.SIGNALLED, 'signalled, and the guest may take it');
        assert.equal(words.get(BASE + 4), EVENT_WORD.MANUAL, 'clear, manual-reset');
        assert.equal(auto.hostKeeps, false);
    });

test('the host reads what the guest left, keeps the word while a thread is queued, and gives it'
    + ' back in the state it left', ()=>{
    const { words, events, sync } = machine();
    events.attach(BASE, 4);
    const event = /** @type {any} */ (sync.createEvent({ manualReset: true }));
    // The guest set it.
    words.set(BASE, EVENT_WORD.SIGNALLED | EVENT_WORD.MANUAL);
    assert.equal(event.signalled, true, 'read from the word');
    assert.ok(hostKeeps(words, BASE), 'the host keeps it now');
    sync.resetEvent(event);
    assert.equal(words.get(BASE), EVENT_WORD.MANUAL, 'back, clear, after the call');
    // A thread queued on it: the host keeps the word until the set that releases it.
    const thread = { name: 'waiter', id: 8 };
    assert.equal(sync.wait(event, thread, undefined), null, 'blocked');
    assert.ok(hostKeeps(words, BASE), 'kept while one waits');
    sync.setEvent(event);
    assert.equal(event.waiters.length, 0, 'released');
    assert.equal(words.get(BASE), EVENT_WORD.SIGNALLED | EVENT_WORD.MANUAL,
        'back to the guest, signalled');
    assert.deepEqual(events.diagnostics(), { words: 1, slots: 4, hostKeeps: 0, detached: false,
        givenBack: 3, taken: 2 });
});

test('while the host keeps the word it writes there whether the event is signalled', ()=>{
    const { words, events, sync } = machine();
    events.attach(BASE, 4);
    const event = /** @type {any} */ (sync.createEvent());
    // A thread waits for it with another event that stays clear: the set
    // cannot release it, and the event stays signalled with a waiter queued.
    const other = /** @type {any} */ (sync.createEvent());
    const thread = { name: 'waiter', id: 8 };
    assert.equal(sync.waitAll([event, other], thread, undefined), null, 'blocked');
    assert.equal(words.get(BASE), EVENT_WORD.HOST, 'the host keeps it, clear');
    sync.setEvent(event);
    assert.equal(event.waiters.length, 1, 'still queued');
    assert.equal(words.get(BASE), EVENT_WORD.HOST | EVENT_WORD.SIGNALLED, 'signalled, the host\'s');
    sync.resetEvent(event);
    assert.equal(words.get(BASE), EVENT_WORD.HOST, 'clear again');
});

test('an auto-reset event taken by the host goes clear in its word', ()=>{
    const { words, events, sync } = machine();
    events.attach(BASE, 4);
    const event = /** @type {any} */ (sync.createEvent());
    words.set(BASE, EVENT_WORD.SIGNALLED);
    assert.equal(sync.poll(event, {}), 0, 'taken');
    assert.equal(words.get(BASE), 0);
});

test('an event another process holds has no word, nor one past the room', ()=>{
    const { events, sync } = machine();
    events.attach(BASE, 1);
    const first = /** @type {any} */ (sync.createEvent());
    const second = /** @type {any} */ (sync.createEvent({ signalled: true }));
    assert.equal(first.word, BASE);
    assert.equal(second.word, undefined, 'past the room');
    assert.equal(second.signalled, true, 'its state the host\'s, as before');
    const standIn = { kind: 'event', manualReset: false, signalled: false, waiters: [], remote: 7 };
    events.made(standIn);
    assert.equal(/** @type {any} */ (standIn).word, undefined);
});

test('detached, the host takes every word the guest has and gives none back until reattached', ()=>{
    // Switched off as a program runs (`app.debug.handleWords(false)`): an event
    // the guest set at that moment stays set, now in the host's hands.
    const { words, events, sync } = machine();
    events.attach(BASE, 4);
    const set = /** @type {any} */ (sync.createEvent());
    const clear = /** @type {any} */ (sync.createEvent({ manualReset: true }));
    words.set(BASE, EVENT_WORD.SIGNALLED);
    events.detach();
    assert.ok(hostKeeps(words, BASE) && hostKeeps(words, BASE + 4), 'both words the host\'s');
    assert.deepEqual([set.signalled, clear.signalled], [true, false]);
    sync.resetEvent(set);
    assert.ok(hostKeeps(words, BASE), 'nobody waits, and still the host keeps it');
    const made = /** @type {any} */ (sync.createEvent({ signalled: true }));
    assert.ok(hostKeeps(words, made.word), 'as one made since');
    events.reattach();
    assert.deepEqual([words.get(BASE), words.get(BASE + 4), words.get(made.word)],
        [0, EVENT_WORD.MANUAL, EVENT_WORD.SIGNALLED], 'reattached: each back to the guest');
});

test('a handle onto an event with a word names the word, and one onto another process\'s event'
    + ' none', ()=>{
    const { events, sync } = machine();
    /** @type {Map<number, number>} */
    const table = new Map();
    const mirror = createEventMirror((address, value)=>void table.set(address, value),
        object=>sync.owns(object));
    const handles = createHandleTable({ watch: mirror });
    events.attach(BASE, 4);
    mirror.attach(TABLE, 1024, []);
    /** @param {number} handle */
    const wordOf = handle=>table.get(TABLE + (handle >>> 2) * 4) ?? MIRROR.NONE;
    const event = /** @type {any} */ (sync.createEvent());
    const handle = handles.open('event', event);
    assert.equal(wordOf(handle), (event.word | EVENT_TAG) >>> 0);
    // An event another kernel on this thread made, found here by its name: its
    // word is in that process's memory.
    const elsewhere = machine();
    elsewhere.events.attach(BASE, 4);
    const theirs = /** @type {any} */ (elsewhere.sync.createEvent());
    assert.equal(theirs.word, BASE);
    assert.equal(wordOf(handles.open('event', theirs)), MIRROR.NONE);
    handles.close(handle);
    assert.equal(wordOf(handle), MIRROR.NONE, 'closed');
});
