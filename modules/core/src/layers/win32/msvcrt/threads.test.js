/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThreadFunctions } from './threads.js';

function build(){
    /** @type {any[]} */
    const started = [];
    /** @type {number[]} */
    const ended = [];
    const PARKED = { parked: true };
    const fns = createThreadFunctions({
        start: request=>{
            started.push(request);
            return request.entry === 0 ? 0 : 0x190 + started.length * 4;
        },
        exit: code=>{
            ended.push(code);
            return PARKED;
        },
    });
    return { fns, started, ended, PARKED };
}

test('_beginthread makes the thread CreateThread makes, and -1 says it could not', ()=>{
    const { fns, started } = build();
    assert.equal(fns._beginthread.handler([0x401000, 0x8000, 0x1234]), 0x194);
    assert.deepEqual(started, [{ entry: 0x401000, stackSize: 0x8000, parameter: 0x1234,
        threadIdOut: 0 }]);
    assert.equal(fns._beginthread.handler([0, 0, 0]), -1);
    assert.equal(fns._beginthread.convention, 'cdecl');
    assert.equal(fns._beginthread.argBytes, 12);
});

test('_beginthreadex passes the id slot through and answers the handle, zero on failure', ()=>{
    const { fns, started } = build();
    assert.equal(fns._beginthreadex.handler([0, 0x1000, 0x402000, 0x99, 0, 0x5000]), 0x194);
    assert.equal(started[0].threadIdOut, 0x5000);
    assert.equal(fns._beginthreadex.handler([0, 0, 0, 0, 0, 0]), 0);
    assert.equal(fns._beginthreadex.argBytes, 24);
});

test('a runtime thread ends through the kernel, and the call does not return', ()=>{
    const { fns, ended, PARKED } = build();
    assert.equal(fns._endthreadex.handler([7]), PARKED);
    assert.equal(fns._endthread.handler([]), PARKED);
    assert.deepEqual(ended, [7, 0]);
    assert.deepEqual([fns._endthread.argBytes, fns._endthreadex.argBytes], [0, 4]);
});
