/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The semaphore's wait and release in the guest answer as their JavaScript,
 * input by input, on cork's test machine: handles past the table, with no
 * word, an event's or a mutex's word, MIRROR's states; counts at zero, one,
 * the maximum and past it, HOST set, a release of zero, a negative count,
 * one past the room, a null previous count. What the JavaScript answers
 * against the host's own WaitForSingleObject and ReleaseSemaphore is
 * `semaphore-guest.itest.js`'s gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMPILED } from './semaphore-guest.x86.js';
import * as sources from './semaphore-guest.js';
import { EVENT_SLOTS } from './wait-one.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';
import { EVENT_TAG, MIRROR, MUTEX_TAG, SEMAPHORE_TAG } from '../../kernel/internal/event-mirror.js';
import { SEMAPHORE_WORD } from '../../kernel/internal/semaphore-words.js';

/** The handle table, a few handles' worth, then the semaphores' words, then a previous count. */
const TABLE = DATA;
const WORDS = DATA + 0x100;
const PREVIOUS = DATA + 0x200;
const HANDLES = 32;

/**
 * Each function's code as the binding places it: HANDLE_WORDS the table the
 * case lays out, as the JavaScript reads it.
 */
const placed = Object.fromEntries(Object.entries(COMPILED).map(([name, record])=>{
    const code = record.code.slice();
    new DataView(code.buffer).setUint32(record.tables.HANDLE_WORDS, TABLE, true);
    return [name, { ...record, code }];
}));
sources.HANDLE_WORDS[0] = TABLE;
const { same } = equivalence(/** @type {any} */ (placed), sources);
/** The host's stand-in: what the trap answers is the gate's, here only that it was reached. */
const HANDED = { host: ()=>0x0badf00d };

test('the constants the guest code reads are the kernel\'s', async()=>{
    const text = await readFile(new URL('./semaphore-guest.js', import.meta.url), 'utf8');
    /** @param {string} name */
    const literal = name=>Number(new RegExp(`^const ${name} = (0x[0-9a-f]+|\\d+);`, 'm')
        .exec(text)?.[1]);
    assert.equal(literal('SLOTS'), EVENT_SLOTS);
    assert.equal(literal('TAG'), SEMAPHORE_TAG);
    assert.equal(literal('HOST'), SEMAPHORE_WORD.HOST);
    assert.equal(literal('COUNT'), SEMAPHORE_WORD.COUNT);
});

test('a semaphore\'s wait and release in the guest answer and write as their JavaScript', ()=>{
    const next = random(7);
    for (let round = 0; round < 3000; round++)
    {
        const bytes = new Uint8Array(0x204);
        const view = new DataView(bytes.buffer);
        // Each handle's word: a semaphore's, an event's or a mutex's own, a
        // mirrored state, or nothing.
        for (let slot = 0; slot < HANDLES; slot++)
        {
            const own = WORDS + (slot % 8) * SEMAPHORE_WORD.SIZE;
            const kinds = [own | SEMAPHORE_TAG, own | SEMAPHORE_TAG, own | SEMAPHORE_TAG,
                own | EVENT_TAG, own | MUTEX_TAG, MIRROR.NONE, MIRROR.CLEAR, MIRROR.SET];
            view.setUint32(slot * 4, kinds[next() % kinds.length] >>> 0, true);
        }
        for (let one = 0; one < 8; one++)
        {
            const maximum = [1, 2, 5, 100, 0x7fffffff, next() & 0x7fffffff || 1][next() % 6];
            const count = [0, 0, 1, maximum, maximum - 1, next() % (maximum + 1)][next() % 6];
            const host = next() % 5 === 0 ? SEMAPHORE_WORD.HOST : 0;
            view.setUint32(0x100 + one * 8, (host | Math.max(0, count)) >>> 0, true);
            view.setUint32(0x100 + one * 8 + 4, maximum, true);
        }
        view.setUint32(0x200, 0x5a5a5a5a, true);
        const handle = [(next() % HANDLES) * 4 + next() % 4, EVENT_SLOTS * 4, 0xffffffff,
            0xfffffff6][next() % 16 === 0 ? 1 + next() % 3 : 0];
        const timeout = [0, 0, 1, 0xffffffff, next()][next() % 5];
        const count = [1, 1, 2, 3, 0, 0xffffffff, 0x7fffffff, 0x80000000, next()][next() % 9];
        const previous = next() % 3 === 0 ? 0 : PREVIOUS;
        const memory = /** @type {[number, Uint8Array][]} */ ([[DATA, bytes]]);
        same('waitSemaphore', { stack: [handle, timeout], memory }, HANDED);
        same('ReleaseSemaphore', { stack: [handle, count, previous], memory }, HANDED);
    }
});
