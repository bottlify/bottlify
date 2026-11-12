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

/** @param {Map<string, any>} [table] @param {Map<number, any>} [processes] */
const service = (table = new Map(), processes = new Map())=>{
    /** @type {[number, number][]} */
    const woken = [];
    const { objects, dispose } = objectHandlers({ table, processes, wake: (token, result)=>{
        woken.push([token, result]);
        return Promise.resolve();
    } });
    return { objects, woken, table, dispose };
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

test('a process across the link that ends leaves no wait behind, and abandons the mutex it held',
    ()=>{
        const table = new Map();
        const scheduler = { block(){}, wake(){}, onTimeout(){} };
        const here = createSyncObjects({ scheduler });
        const event = here.createEvent({ manualReset: true, signalled: false, name: 'E' });
        table.set('E', { kind: 'event', object: event, refs: 1 });
        const { objects, dispose } = service(table);
        const found = /** @type {any} */ (objects.peek('event', 'E'));
        assert.equal(objects.wait(found.id, 1, 1), null);
        assert.equal(/** @type {any} */ (objects.create('mutex', 'M', { owner: 1 })).reused,
            false);
        const object = table.get('M').object;
        const local = { id: 99, suspendCount: 0, waitSet: null, queuedOn: null, state: 'running',
            scheduler: { wake(){} } };
        assert.equal(here.wait(object, local), null, 'a thread here waits on it');
        dispose();
        assert.deepEqual(event.waiters, [], 'the ended process waits on nothing');
        assert.equal(object.owner, local, 'its mutex went to the next waiter');
        assert.equal(/** @type {any} */ (local).waitResult, 0x80, 'told it was abandoned');
    });

/**
 * A process across the link: its kernel's objects, one of them a stand-in of
 * an event the run's table holds, and one of its threads.
 */
function farProcess(){
    /** @type {any} */
    let far = null;
    const { objects } = objectHandlers({ table: new Map(), wake: (token, result)=>{
        far.wakeRemote(token, result);
        return Promise.resolve();
    } });
    /** @type {any[]} */
    const woken = [];
    const scheduler = { block(){}, wake: (/** @type {any} */ one)=>woken.push(one),
        onTimeout(){} };
    far = createSyncObjects({ scheduler, remote: {
        wait: (id, threadId, token)=>objects.wait(id, threadId, token),
        cancel: token=>objects.cancel(token),
        poll: (id, threadId)=>objects.poll(id, threadId),
        set: id=>objects.set(id),
        reset: id=>objects.reset(id),
        release: (id, count)=>objects.release(id, count),
        releaseMutex: (id, threadId)=>objects.releaseMutex(id, threadId),
    } });
    const { id } = /** @type {any} */ (objects.create('event', 'Served', { manualReset: false,
        signalled: false }));
    const standIn = far.createEvent({ name: 'Served' });
    standIn.remote = id;
    const local = far.createEvent({ name: 'Mine' });
    const thread = { id: 4, suspendCount: 0, waitSet: null, queuedOn: null, state: 'running' };
    return { objects, far, id, standIn, local, thread, woken };
}

test('a wait for any of a set with another process\'s event in it ends with whichever comes',
    ()=>{
        // ngen under concurrency: its own event and one its worker process
        // made, in one WaitForMultipleObjects.
        const one = farProcess();
        assert.equal(one.far.waitAny([one.local, one.standIn], one.thread), null, 'neither yet');
        one.objects.set(one.id);
        assert.deepEqual(one.woken, [one.thread], 'the other process\'s set woke it');
        assert.equal(/** @type {any} */ (one.thread).waitResult, 1, 'with that object\'s index');
        assert.deepEqual(one.local.waiters, [], 'and it waits here on nothing');

        const two = farProcess();
        assert.equal(two.far.waitAny([two.local, two.standIn], two.thread), null);
        two.far.setEvent(two.local);
        assert.equal(/** @type {any} */ (two.thread).waitResult, 0, 'its own event came first');
        two.objects.set(two.id);
        assert.equal(two.objects.poll(two.id, 9), OBJECT_0,
            'the other wait was taken back: the set stayed for the next look');

        const ready = farProcess();
        ready.objects.set(ready.id);
        assert.deepEqual(ready.far.waitAny([ready.local, ready.standIn], ready.thread),
            { index: 1, result: OBJECT_0 }, 'signalled already: taken at once');
    });

test('an object of another process handed over after the wait had ended goes back', ()=>{
    const one = farProcess();
    // The other process's set reaches the table, and its word of it is still
    // on its way when the event here comes.
    const wake = one.far.wakeRemote;
    /** @type {[number, number][]} */
    const late = [];
    one.far.wakeRemote = (/** @type {number} */ token, /** @type {number} */ result)=>{
        late.push([token, result]);
    };
    assert.equal(one.far.waitAny([one.local, one.standIn], one.thread), null);
    one.objects.set(one.id);
    assert.equal(late.length, 1, 'handed over there');
    one.far.setEvent(one.local);
    assert.equal(/** @type {any} */ (one.thread).waitResult, 0, 'the event here ended it');
    wake(...late[0]);
    assert.equal(/** @type {any} */ (one.thread).waitResult, 0, 'the late word changes nothing');
    assert.equal(one.objects.poll(one.id, 9), OBJECT_0, 'and the other event was set again');
});

test('a process of the run is found across the link by its id: its exit is an object a thread'
    + ' there waits on, and its code is read once it has one', ()=>{
    const here = createSyncObjects({ scheduler: { block(){}, wake(){}, onTimeout(){} } });
    const record = { kind: 'process', id: 8120, threadId: 8121, imagePath: 'C:\\ngen.exe',
        completed: false, exitCode: 259,
        exited: here.createEvent({ manualReset: true, signalled: false, name: 'process 8120' }) };
    const { objects, woken } = service(new Map(), new Map([[8120, record]]));
    assert.equal(objects.process(8200), null, 'an id no process of the run has');
    const found = /** @type {any} */ (objects.process(8120));
    assert.deepEqual({ ...found, id: typeof found.id }, { id: 'number', threadId: 8121,
        imagePath: 'C:\\ngen.exe', exitCode: null }, 'running: no code yet');
    assert.equal(objects.wait(found.id, 9, 11), null, 'a wait on a running process is queued');
    record.completed = true;
    record.exitCode = 3;
    here.setEvent(record.exited);
    assert.deepEqual(woken, [[11, OBJECT_0]], 'its exit reached the waiter there');
    assert.equal(/** @type {any} */ (objects.process(8120)).exitCode, 3);
    assert.equal(objects.poll(found.id, 9), OBJECT_0, 'and stays signalled, as a process does');
});
