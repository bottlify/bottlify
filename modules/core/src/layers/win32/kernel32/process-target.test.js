/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandleTable } from '../../kernel/internal/handles.js';
import { grantedAccess } from './access.js';
import {
    CURRENT_PROCESS, PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_VM_OPERATION, PROCESS_VM_READ, PROCESS_VM_WRITE, createProcessTarget,
} from './process-target.js';

const OWN_ID = 0x40;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;

/** A handle table and a resolver over it. */
function setUp(){
    const kernel = { handles: createHandleTable() };
    return { kernel, target: createProcessTarget({ kernel, processId: ()=>OWN_ID }) };
}

/** @param {number} desired */
const granted = desired=>{
    const access = grantedAccess('process', desired);
    assert.ok(!('error' in access));
    return access.granted;
};

test('the pseudo-handle and a handle opened for its own id are this process', ()=>{
    const { kernel, target } = setUp();
    assert.deepEqual(target(CURRENT_PROCESS, PROCESS_VM_WRITE), { here: true });
    const own = kernel.handles.open('process', { kind: 'process', id: OWN_ID }, null);
    assert.deepEqual(target(own, PROCESS_VM_OPERATION), { here: true });
    const current = kernel.handles.open('process', { kind: 'process', current: true }, null);
    assert.deepEqual(target(current, PROCESS_VM_READ), { here: true });
});

test('a child is reached as a child, and a handle that names no process is refused', ()=>{
    const { kernel, target } = setUp();
    const record = { kind: 'process', id: 0x88 };
    const child = kernel.handles.open('process', record, null);
    assert.deepEqual(target(child, PROCESS_VM_READ), { child: record });
    assert.deepEqual(target(0, PROCESS_VM_READ), { error: ERROR_INVALID_HANDLE });
    const event = kernel.handles.open('event', { kind: 'event' }, null);
    assert.deepEqual(target(event, PROCESS_VM_READ), { error: ERROR_INVALID_HANDLE });
});

test('a call needs the right it uses, whichever process the handle names', ()=>{
    // Wine's process test_OpenProcess: a handle without PROCESS_VM_OPERATION
    // cannot allocate, one with only it cannot query or read.
    const { kernel, target } = setUp();
    const self = { kind: 'process', id: OWN_ID };
    const noOperation = kernel.handles.open('process', self, granted(0x1f0fff & ~0x8));
    assert.deepEqual(target(noOperation, PROCESS_VM_OPERATION), { error: ERROR_ACCESS_DENIED });
    assert.deepEqual(target(noOperation, PROCESS_VM_READ), { here: true });
    const operation = kernel.handles.open('process', self, granted(PROCESS_VM_OPERATION));
    assert.deepEqual(target(operation, PROCESS_VM_OPERATION), { here: true });
    assert.deepEqual(target(operation, PROCESS_QUERY_INFORMATION), { error: ERROR_ACCESS_DENIED });
    assert.deepEqual(target(operation, PROCESS_VM_READ), { error: ERROR_ACCESS_DENIED });
});

test('a process\'s generic rights and the limited query right its full one carries', ()=>{
    assert.equal(granted(PROCESS_QUERY_INFORMATION),
        PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION);
    assert.equal(granted(0x80000000), 0x00020410 | PROCESS_QUERY_LIMITED_INFORMATION,
        'GENERIC_READ: READ_CONTROL, VM_READ, QUERY_INFORMATION and its limited form');
    assert.equal(granted(0x10000000), null, 'GENERIC_ALL is every right');
    assert.deepEqual(grantedAccess('process', 0), { error: ERROR_ACCESS_DENIED });
});
