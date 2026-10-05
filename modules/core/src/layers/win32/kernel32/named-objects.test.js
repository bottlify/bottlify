/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAKEN, createNamedObjects, createRemoteNamedObjects } from './named-objects.js';

const ERROR_SUCCESS = 0;
const ERROR_ALREADY_EXISTS = 183;

/** @returns {{ errors: number[], setLastError: (code: number) => void }} */
function errorSink(){
    /** @type {number[]} */
    const errors = [];
    return { errors, setLastError: code=>errors.push(code) };
}

test('a fresh create is remembered and reported as success', ()=>{
    const registry = createNamedObjects();
    const { errors, setLastError } = errorSink();
    const mutex = { kind: 'mutex' };

    registry.remember('Warcraft III', 'mutex', mutex, false, setLastError);

    assert.equal(registry.existing('Warcraft III', 'mutex'), mutex);
    assert.deepEqual(errors, [ERROR_SUCCESS]);
});

test('a reuse is reported as already existing, and does not replace the object', ()=>{
    const registry = createNamedObjects();
    const { errors, setLastError } = errorSink();
    const mutex = { kind: 'mutex' };
    registry.remember('Warcraft III', 'mutex', mutex, false, setLastError);

    const found = registry.existing('Warcraft III', 'mutex');
    registry.remember('Warcraft III', 'mutex', found, true, setLastError);

    assert.equal(registry.existing('Warcraft III', 'mutex'), mutex);
    assert.deepEqual(errors, [ERROR_SUCCESS, ERROR_ALREADY_EXISTS]);
});

test('a name is not a match for a different kind of object', ()=>{
    const registry = createNamedObjects();
    registry.remember('shared', 'mutex', { kind: 'mutex' }, false, ()=>{});

    assert.equal(registry.existing('shared', 'event'), TAKEN);
});

test('a name nothing made is free', ()=>{
    const registry = createNamedObjects();
    assert.equal(registry.existing('nothing', 'mutex'), null);
    assert.equal(registry.existing(null, 'mutex'), null, 'no name is never a match');
});

test('the last handle closed frees the name for a create that means it for real', ()=>{
    // The canonical single-instance idiom: probe for a first copy, close the
    // probe, then create the object for real. The second create must not be
    // told its own probe took the name.
    const registry = createNamedObjects();
    const { errors, setLastError } = errorSink();
    const probe = { kind: 'mutex' };

    registry.remember('Warcraft III', 'mutex', probe, false, setLastError);
    registry.forget(probe);
    registry.remember('Warcraft III', 'mutex', { kind: 'mutex' }, false, setLastError);

    assert.deepEqual(errors, [ERROR_SUCCESS, ERROR_SUCCESS],
        'the second create found no name held, because the only handle to it closed');
});

test('a second handle keeps the name alive until both are closed', ()=>{
    const registry = createNamedObjects();
    const { setLastError } = errorSink();
    const mutex = { kind: 'mutex' };
    registry.remember('Warcraft III', 'mutex', mutex, false, setLastError);
    registry.reference(mutex);

    registry.forget(mutex);
    assert.equal(registry.existing('Warcraft III', 'mutex'), mutex,
        'one of the two handles onto it is still open');

    registry.forget(mutex);
    assert.equal(registry.existing('Warcraft III', 'mutex'), null);
});

test('forgetting an object nothing named is a no-op', ()=>{
    const registry = createNamedObjects();
    assert.doesNotThrow(()=>registry.forget({ kind: 'mutex' }));
});

test('a table handed in is what makes a name survive a process replacement', ()=>{
    // The table is constructed once outside any one process and handed to
    // every rebuild -- the same shape as the log's sinks and the sound ring
    // in createApp. A parent's create and a child's create against the same
    // table see the same object, with no handle table in common at all.
    const table = new Map();
    const parent = createNamedObjects({ table });
    const { errors: parentErrors, setLastError: parentSetLastError } = errorSink();
    const mutex = { kind: 'mutex' };
    parent.remember('Warcraft III', 'mutex', mutex, false, parentSetLastError);

    // The parent's process ends without ever closing its handle -- exactly
    // what a replacement does -- so its reference to the object is still
    // counted when the child looks.
    const child = createNamedObjects({ table });
    const { errors: childErrors, setLastError: childSetLastError } = errorSink();
    const found = child.existing('Warcraft III', 'mutex');
    child.remember('Warcraft III', 'mutex', found, found !== null, childSetLastError);

    assert.equal(found, mutex);
    assert.deepEqual(childErrors, [ERROR_ALREADY_EXISTS]);
    assert.deepEqual(parentErrors, [ERROR_SUCCESS]);
});

test('across a link, events, semaphores and mutexes are the run\'s; a mapping\'s name stays the'
    + ' process\'s own', ()=>{
    /** @type {any[]} */
    const asked = [];
    const objects = {
        peek: (/** @type {string} */ kind, /** @type {string} */ name)=>{
            asked.push(['peek', kind, name]);
            return name === 'Ready' ? { id: 4 } : null;
        },
        create: (/** @type {string} */ kind, /** @type {string} */ name)=>{
            asked.push(['create', kind, name]);
            return { id: 5, reused: false };
        },
        reference: (/** @type {number} */ id)=>asked.push(['reference', id]),
        close: (/** @type {number} */ id)=>asked.push(['close', id]),
    };
    const kernel = {
        createEvent: (/** @type {any} */ options)=>({ kind: 'event', ...options }),
        createSemaphore: (/** @type {any} */ options)=>({ kind: 'semaphore', ...options }),
        createMutex: (/** @type {any} */ options)=>({ kind: 'mutex', ...options }),
    };
    const names = createRemoteNamedObjects({ objects, kernel });
    const found = names.existing('Ready', 'event');
    assert.equal(found.remote, 4, 'a stand-in for the run\'s object');
    assert.equal(names.existing('Ready', 'event'), found, 'one stand-in for it');
    /** @type {number[]} */
    const errors = [];
    const made = { kind: 'event', manualReset: true, signalled: false };
    names.remember('Go', 'event', made, false, code=>errors.push(code));
    assert.equal(/** @type {any} */ (made).remote, 5, 'made there, a stand-in here');

    const mapping = { kind: 'mapping' };
    assert.equal(names.existing('Shared', 'mapping'), null);
    names.remember('Shared', 'mapping', mapping, false, code=>errors.push(code));
    assert.equal(names.existing('Shared', 'mapping'), mapping, 'its own table holds it');
    names.forget(mapping);
    assert.equal(names.existing('Shared', 'mapping'), null);
    assert.deepEqual(asked.filter(each=>each[1] === 'mapping'), [], 'never asked across');
    assert.deepEqual(errors, [0, 0]);
});
