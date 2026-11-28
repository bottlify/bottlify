/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestOver } from '../common/guest.fixture.js';
import { createHandleTableFunctions } from './handle-table.js';

function setup(){
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    let heap = 0x4000;
    /** @type {number[]} */
    const freed = [];
    const fns = createHandleTableFunctions({
        guest: guestOver(memory),
        allocate: bytes=>(heap += bytes) - bytes,
        free: address=>freed.push(address) > 0,
    });
    return { fns, view, freed };
}

test('a record is given out by index, valid once marked in use, and freed back first', ()=>{
    const { fns, view, freed } = setup();
    const TABLE = 0x100;
    fns.RtlInitializeHandleTable.handler([4, 16, TABLE]);
    const first = fns.RtlAllocateHandle.handler([TABLE, 0x200]);
    assert.notEqual(first, 0);
    assert.equal(view.getUint32(0x200, true), 0, 'index 0');
    assert.equal(fns.RtlIsValidIndexHandle.handler([TABLE, 0, 0x204]), 0, 'not yet marked in use');
    view.setUint32(first, 1, true);
    assert.equal(fns.RtlIsValidIndexHandle.handler([TABLE, 0, 0x204]), 1);
    assert.equal(view.getUint32(0x204, true), first);
    const second = fns.RtlAllocateHandle.handler([TABLE, 0x200]);
    assert.equal(second, first + 16);
    assert.equal(view.getUint32(0x200, true), 1);
    assert.equal(fns.RtlFreeHandle.handler([TABLE, second]), 0, 'a record not in use');
    assert.equal(fns.RtlFreeHandle.handler([TABLE, first]), 1);
    assert.equal(fns.RtlIsValidIndexHandle.handler([TABLE, 0, 0x204]), 0, 'freed');
    assert.equal(fns.RtlAllocateHandle.handler([TABLE, 0x200]), first, 'the freed one first');
    for (let i = 0; i < 2; i++)
    {
        assert.notEqual(fns.RtlAllocateHandle.handler([TABLE, 0x200]), 0);
    }
    assert.equal(fns.RtlAllocateHandle.handler([TABLE, 0x200]), 0, 'the table is full');
    assert.equal(fns.RtlDestroyHandleTable.handler([TABLE]), 0);
    assert.deepEqual(freed, [first]);
});
