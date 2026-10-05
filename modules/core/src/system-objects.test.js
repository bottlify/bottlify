/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { objectHandlers } from './system-objects.js';
import { createSyncObjects } from './layers/kernel/internal/sync.js';

const OBJECT_0 = 0;

/** @param {Map<string, any>} [table] */
const service = (table = new Map())=>{
    /** @type {[number, number][]} */
    const woken = [];
    const { objects } = objectHandlers({ table, wake: (token, result)=>{
        woken.push([token, result]);
        return Promise.resolve();
    } });
    return { objects, woken, table };
};

test('a wait across the link is answered now, queued, or given up -- and a wait already handed'
    + ' its object keeps it however late it is given up', ()=>{
    const { objects, woken } = service();
    const { id } = /** @type {any} */ (objects.create('event', 'Go', { manualReset: false,
        signalled: true }));
    assert.equal(objects.wait(id, 7, 1), OBJECT_0, 'signalled: taken at once');
    assert.equal(objects.wait(id, 7, 2), null, 'and reset by the taking: queued');
    assert.equal(objects.cancel(2), null, 'given up while queued');
    objects.set(id);
    assert.deepEqual(woken, [], 'nobody was waiting any more');
    assert.equal(objects.poll(id, 7), OBJECT_0, 'so it stayed signalled for the next look');

    assert.equal(objects.wait(id, 7, 3), null);
    objects.set(id);
    assert.deepEqual(woken, [[3, OBJECT_0]], 'handed to the waiter, which is told');
    assert.equal(objects.cancel(3), OBJECT_0, 'a time-out after that still has the object');
});

test('a thread across the link waits on an object a process here named, and a set here wakes it',
    ()=>{
        const table = new Map();
        const scheduler = { block(){}, wake(){}, onTimeout(){} };
        const here = createSyncObjects({ scheduler });
        const event = here.createEvent({ manualReset: false, signalled: false, name: 'Ready' });
        table.set('Ready', { kind: 'event', object: event, refs: 1 });
        const { objects, woken } = service(table);
        assert.deepEqual(objects.peek('mutex', 'Ready'), { taken: true });
        const found = /** @type {any} */ (objects.peek('event', 'Ready'));
        assert.equal(objects.wait(found.id, 9, 5), null);
        here.setEvent(event);
        assert.deepEqual(woken, [[5, OBJECT_0]], 'the set here reached the waiter there');
        assert.equal(event.signalled, false, 'and the auto-reset event was taken by it');
    });

test('the last close frees the name; a semaphore and a mutex keep their counts and owner', ()=>{
    const { objects, table } = service();
    const made = /** @type {any} */ (objects.create('semaphore', 'Slots', { initial: 1,
        maximum: 2 }));
    assert.equal(made.reused, false);
    assert.deepEqual(objects.create('semaphore', 'Slots', {}), { id: made.id, reused: true });
    assert.equal(objects.poll(made.id, 1), OBJECT_0);
    assert.equal(objects.poll(made.id, 1), null, 'one count, taken');
    assert.equal(objects.release(made.id, 2), 0);
    objects.close(made.id);
    assert.ok(table.has('Slots'));
    objects.close(made.id);
    assert.ok(!table.has('Slots'), 'gone with its last handle');

    const mutex = /** @type {any} */ (objects.create('mutex', 'One', { owner: 3 }));
    assert.equal(objects.poll(mutex.id, 4), null, 'owned by the thread that made it');
    assert.equal(objects.releaseMutex(mutex.id, 4), false, 'released only by its owner');
    assert.equal(objects.releaseMutex(mutex.id, 3), true);
    assert.equal(objects.poll(mutex.id, 4), OBJECT_0);
});
