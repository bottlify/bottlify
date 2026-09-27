/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createErrorFunctions, messageOf } from './errors.js';
import { fakeMemory } from './harness.test.js';

const build = ()=>{
    const memory = fakeMemory();
    const cells = { errno: 9, doserrno: 5 };
    const table = /** @type {Record<string, any>} */ (createErrorFunctions({
        writeMemory: memory.writeMemory,
        allocate: memory.allocate,
        errno: ()=>cells.errno,
        setErrno: code=>{
            cells.errno = code;
        },
        doserrno: ()=>cells.doserrno,
        setDoserrno: code=>{
            cells.doserrno = code;
        },
    }));
    return { memory, table, cells };
};

test('_get_errno and _get_doserrno read the cells, and refuse no pointer', ()=>{
    const { memory, table, cells } = build();
    const out = memory.allocate(4);
    assert.equal(table._get_errno.handler([out]), 0);
    assert.equal(memory.u32(out), 9);
    assert.equal(table._get_doserrno.handler([out]), 0);
    assert.equal(memory.u32(out), 5);
    assert.equal(table._get_errno.handler([0]), 22);
    assert.equal(cells.errno, 9, 'errno left for the caller to read');
    assert.equal(table._set_errno.handler([34]), 0);
    assert.equal(table._set_doserrno.handler([2]), 0);
    assert.deepEqual(cells, { errno: 34, doserrno: 2 });
});

test('strerror and strerror_s say what an errno means', ()=>{
    const { memory, table, cells } = build();
    assert.equal(memory.text(table.strerror.handler([2])), 'No such file or directory');
    assert.equal(memory.text(table.strerror.handler([1000])), 'Unknown error');
    assert.equal(messageOf(42), 'Illegal byte sequence');
    const buffer = memory.allocate(32);
    memory.fillMemory(buffer, 0x58, 32);
    assert.equal(table.strerror_s.handler([buffer, 0, 0]), 22);
    assert.equal(memory.text(buffer).slice(0, 1), 'X', 'nothing written');
    assert.equal(cells.errno, 22);
    assert.equal(table.strerror_s.handler([buffer, 2, 0]), 0, 'cut short, and no error');
    assert.equal(memory.text(buffer), 'N');
    assert.equal(table.strerror_s.handler([buffer, 32, 0]), 0);
    assert.equal(memory.text(buffer), 'No error');
});
