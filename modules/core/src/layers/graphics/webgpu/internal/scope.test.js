/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeOf } from './scope.js';

/** A backend that keeps what it was asked. */
function recorder(){
    /** @type {string[]} */
    const log = [];
    let made = 0;
    return {
        log,
        backend: {
            other: ()=>'kept',
            createSurface: ()=>({ surface: made++ }),
            destroySurface: (/** @type {any} */ one)=>log.push(`destroy ${one.surface}`),
            createDynamicBuffer: ()=>({ buffer: made++ }),
            releaseDynamicBuffer: (/** @type {any} */ one)=>log.push(`release ${one.buffer}`),
        },
    };
}

test('a scope gives back what its owner made and did not give back itself, once', ()=>{
    const { backend, log } = recorder();
    /** @type {any[]} */
    const forgotten = [];
    const scope = scopeOf(backend, surface=>forgotten.push(surface.surface));
    const kept = scope.createSurface({});
    const gone = scope.createSurface({});
    const buffer = scope.createDynamicBuffer({});
    const freed = scope.createDynamicBuffer({});
    scope.destroySurface(gone);
    scope.releaseDynamicBuffer(freed);
    assert.equal(scope.other(), 'kept', 'every other call is the backend\'s');
    assert.deepEqual(scope.held(), { surfaces: 1, buffers: 1 });
    scope.giveBack();
    assert.deepEqual(log, ['destroy 1', 'release 3', 'destroy 0', 'release 2']);
    assert.deepEqual(forgotten, [kept.surface], 'the backend told of each surface it goes back');
    assert.deepEqual(scope.held(), { surfaces: 0, buffers: 0 });
    scope.giveBack();
    assert.equal(log.length, 4, 'nothing given back twice');
    assert.equal(buffer.buffer, 2);
});

test('a scope of a view keeps the view\'s own calls', ()=>{
    const { backend } = recorder();
    const view = Object.create(backend, { other: { value: ()=>'the view\'s' } });
    assert.equal(scopeOf(view, ()=>{}).other(), 'the view\'s');
});
