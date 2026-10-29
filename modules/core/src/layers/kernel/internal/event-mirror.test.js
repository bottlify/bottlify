/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIRROR, createEventMirror } from './event-mirror.js';
import { createHandleTable } from './handles.js';
import { createSyncObjects } from './sync.js';

const TABLE = 0x10000;

/** A kernel's events and handles with the mirror between them, over a memory of words. */
function machine(){
    /** @type {Map<number, number>} */
    const memory = new Map();
    const mirror = createEventMirror((address, value)=>void memory.set(address, value));
    const scheduler = { block(){}, wake(){}, addTimer: ()=>1, removeTimer(){} };
    const sync = createSyncObjects({ scheduler, eventChanged: event=>mirror.changed(event) });
    const handles = createHandleTable({ watch: mirror });
    /** @param {number} handle */
    const wordOf = handle=>memory.get(TABLE + (handle >>> 2) * 4) ?? MIRROR.NONE;
    return { mirror, sync, handles, wordOf };
}

test('each handle onto an event says whether it is signalled, through every change', ()=>{
    const { mirror, sync, handles, wordOf } = machine();
    const before = sync.createEvent({ signalled: true });
    const early = handles.open('event', before);
    mirror.attach(TABLE, 1024, handles.list());
    assert.equal(wordOf(early), MIRROR.SET, 'an event open before the table has its word');

    const auto = sync.createEvent();
    const one = handles.open('event', auto);
    const two = handles.open('event', auto);
    assert.equal(wordOf(one), MIRROR.CLEAR);
    sync.setEvent(auto);
    assert.equal(wordOf(one), MIRROR.SET);
    assert.equal(wordOf(two), MIRROR.SET, 'every handle onto it');
    assert.equal(sync.poll(auto, {}), 0, 'taken');
    assert.equal(wordOf(one), MIRROR.CLEAR, 'an auto-reset event taken is clear again');
    sync.setEvent(auto);
    sync.resetEvent(auto);
    assert.equal(wordOf(two), MIRROR.CLEAR);
    handles.close(one);
    assert.equal(wordOf(one), MIRROR.NONE, 'a closed handle has nothing to say');
    sync.setEvent(auto);
    assert.equal(wordOf(one), MIRROR.NONE, 'and is not written again');
    assert.equal(wordOf(two), MIRROR.SET);

    const mutex = handles.open('mutex', sync.createMutex());
    assert.equal(wordOf(mutex), MIRROR.NONE, 'only events');
    const standIn = /** @type {any} */ (sync.createEvent());
    standIn.remote = 7;
    assert.equal(wordOf(handles.open('event', standIn)), MIRROR.NONE,
        'nor an event another process holds');
});

test('a handle past the table has no word, and nothing is written before the table', ()=>{
    const { mirror, sync, handles, wordOf } = machine();
    const event = sync.createEvent();
    const handle = handles.open('event', event);
    sync.setEvent(event);
    assert.equal(wordOf(handle), MIRROR.NONE);
    mirror.attach(TABLE, handle >>> 2, []);
    const past = handles.open('event', sync.createEvent());
    assert.equal(wordOf(past), MIRROR.NONE);
});

test('a table detached says nothing for any handle until it is attached again', ()=>{
    // Switched off as a program runs (`app.debug.handleWords(false)`): every
    // guest wait and SetEvent crosses from then on, as with no table.
    const { mirror, sync, handles, wordOf } = machine();
    const event = sync.createEvent({ signalled: true });
    const open = handles.open('event', event);
    mirror.attach(TABLE, 1024, handles.list());
    assert.equal(mirror.attached(), true);
    mirror.detach();
    assert.equal(mirror.attached(), false);
    assert.equal(wordOf(open), MIRROR.NONE, 'an open handle says nothing');
    sync.resetEvent(event);
    sync.setEvent(event);
    const later = handles.open('event', sync.createEvent());
    assert.deepEqual([wordOf(open), wordOf(later)], [MIRROR.NONE, MIRROR.NONE],
        'nor a change, nor a handle opened since');
    sync.resetEvent(event);
    mirror.reattach(handles.list());
    assert.equal(mirror.attached(), true);
    assert.deepEqual([wordOf(open), wordOf(later)], [MIRROR.CLEAR, MIRROR.CLEAR],
        'attached again: every open handle as its event stands now');
    sync.setEvent(event);
    assert.equal(wordOf(open), MIRROR.SET, 'and every change after');
});

test('a handle granted fewer than all rights has no word: its calls are the host\'s to check',
    ()=>{
        // An OpenEvent without SYNCHRONIZE cannot be waited on, which only the
        // host can refuse; a word would let the guest take the event anyway.
        const { mirror, sync, handles, wordOf } = machine();
        mirror.attach(TABLE, 1024, []);
        const event = sync.createEvent({ signalled: true });
        const all = handles.open('event', event);
        const narrow = handles.open('event', event, 0x20002);
        assert.equal(wordOf(all), MIRROR.SET);
        assert.equal(wordOf(narrow), MIRROR.NONE);
        assert.equal(handles.access(narrow), 0x20002);
        assert.equal(handles.access(all), null);
        assert.deepEqual(handles.list().map(entry=>entry.access), [null, 0x20002]);
    });
