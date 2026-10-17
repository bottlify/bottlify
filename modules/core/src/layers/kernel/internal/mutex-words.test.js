/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MUTEX_WORD, createMutexWords } from './mutex-words.js';

const BASE = 0x1000;

/** A guest memory of words, and threads by id. */
const hostKeeps = (/** @type {Map<number, number>} */ words, /** @type {number} */ at)=>
    ((words.get(at) ?? 0) & MUTEX_WORD.HOST) === MUTEX_WORD.HOST;

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
    const threads = [{ id: 0x2c }, { id: 0x30 }];
    const mutexes = createMutexWords(memory,
        id=>threads.find(thread=>thread.id === id) ?? null);
    /** A mutex as the kernel makes one. */
    const make = (/** @type {any} */ extra = {})=>{
        const mutex = { kind: 'mutex', owner: null, recursion: 0, abandoned: false, waiters: [],
            ...extra };
        mutexes.made(mutex);
        return /** @type {any} */ (mutex);
    };
    return { words, memory, threads, mutexes, make };
}

test('a mutex made before there is room gets its word once there is, free, the guest\'s', ()=>{
    const { words, mutexes, make } = machine();
    const mutex = make();
    assert.equal(mutex.word, undefined);
    mutexes.attach(BASE, 4);
    assert.equal(mutex.word, BASE);
    assert.equal(words.get(BASE), 0, 'free, and the guest may take it');
    assert.equal(mutex.hostKeeps, false);
});

test('the host reads what the guest left and keeps the word until nobody waits', ()=>{
    const { words, threads, mutexes, make } = machine();
    mutexes.attach(BASE, 4);
    const mutex = make();
    // The guest took it twice.
    words.set(BASE, (0x2c << MUTEX_WORD.OWNER_SHIFT) | 2);
    assert.equal(mutex.owner, threads[0], 'the owner, by its id');
    assert.equal(mutex.recursion, 2);
    assert.ok(hostKeeps(words, BASE), 'the host keeps it now');
    // Another thread waits; the host hands it over on the release.
    mutex.waiters.push(threads[1]);
    mutexes.settle();
    assert.ok(hostKeeps(words, BASE), 'kept while one waits');
    mutex.waiters.length = 0;
    mutex.owner = threads[1];
    mutex.recursion = 1;
    mutexes.settle();
    assert.equal(words.get(BASE), (0x30 << MUTEX_WORD.OWNER_SHIFT) | 1, 'the new owner\'s, back');
    assert.equal(mutex.hostKeeps, false);
});

test('an owner the host cannot find left it abandoned, which the host keeps to say', ()=>{
    const { words, mutexes, make } = machine();
    mutexes.attach(BASE, 4);
    const mutex = make();
    words.set(BASE, (0x99 << MUTEX_WORD.OWNER_SHIFT) | 1);
    assert.equal(mutex.owner, null);
    assert.equal(mutex.abandoned, true);
    mutexes.settle();
    assert.ok(hostKeeps(words, BASE), 'the next taker is told');
});

test('a count the word cannot carry, or a mutex another process holds, stays the host\'s', ()=>{
    const { words, threads, mutexes, make } = machine();
    mutexes.attach(BASE, 4);
    const deep = make();
    deep.owner = threads[0];
    deep.recursion = MUTEX_WORD.RECURSION + 1;
    mutexes.settle();
    assert.ok(hostKeeps(words, deep.word));
    const shared = make({ remote: 7 });
    assert.equal(shared.word, undefined, 'no word at all');
    assert.deepEqual(mutexes.diagnostics(), { words: 1, slots: 4, hostKeeps: 1 });
});

test('past the room, a mutex has no word and the host keeps it as before', ()=>{
    const { mutexes, make } = machine();
    mutexes.attach(BASE, 1);
    const first = make();
    const second = make();
    assert.equal(first.word, BASE);
    assert.equal(second.word, undefined);
    second.owner = null;
    assert.equal(second.owner, null);
});
