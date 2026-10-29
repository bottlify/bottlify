/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNKNOWN_ORDINALS, createUnknownFunctions } from './unknown.js';

const E_FAIL = 0x80004005 | 0;
const E_NOINTERFACE = 0x80004002 | 0;

/**
 * A guest with one object whose methods are host functions by their entry:
 * QueryInterface hands out a service provider for IID_IServiceProvider (or
 * refuses when `provides` is false), and QueryService writes 0x5150 into the
 * out-pointer it is given.
 *
 * @param {{ provides?: boolean }} [options]
 */
function machine({ provides = true } = {}){
    const memory = new Uint8Array(0x2000);
    const view = new DataView(memory.buffer);
    const OBJECT = 0x100, OBJECT_VTABLE = 0x120, PROVIDER = 0x200, PROVIDER_VTABLE = 0x220;
    view.setUint32(OBJECT, OBJECT_VTABLE, true);
    view.setUint32(PROVIDER, PROVIDER_VTABLE, true);
    // Entries are numbers the fake `call` dispatches on.
    [0xa0, 0xa1, 0xa2].forEach((entry, slot)=>
        view.setUint32(OBJECT_VTABLE + slot * 4, entry, true));
    [0xb0, 0xb1, 0xb2, 0xb3].forEach((entry, slot)=>
        view.setUint32(PROVIDER_VTABLE + slot * 4, entry, true));
    /** @type {string[]} */
    const calls = [];
    let next = 0x1000;
    /** @type {number[]} */
    const freed = [];
    const fns = createUnknownFunctions({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        allocate: bytes=>{
            const at = next;
            next += bytes + 15 & ~15;
            return at;
        },
        free: address=>freed.push(address),
        callerThread: ()=>'main',
        call: (entry, args, thread)=>{
            assert.equal(thread, 'main');
            switch (entry)
            {
                case 0xa0: {
                    const iid = [...memory.subarray(args[1], args[1] + 16)]
                        .map(byte=>byte.toString(16).padStart(2, '0')).join('');
                    calls.push(`QueryInterface ${iid}`);
                    if (!provides)
                    {
                        return E_NOINTERFACE;
                    }
                    view.setUint32(args[2], PROVIDER, true);
                    return 0;
                }
                case 0xb3:
                    calls.push(`QueryService ${args[1].toString(16)} ${args[2].toString(16)}`);
                    view.setUint32(args[3], 0x5150, true);
                    return 0;
                case 0xb2:
                    calls.push('Release');
                    return 0;
                default:
                    throw new Error(`unexpected entry ${entry}`);
            }
        },
    });
    return { memory, view, fns, calls, freed, OBJECT };
}

test('IUnknown_QueryService asks the object\'s service provider and lets it go', async()=>{
    // Wine's shlwapi ordinal test_IUnknown_QueryService: QueryInterface for
    // IServiceProvider, QueryService, Release, in that order.
    const { view, fns, calls, freed, OBJECT } = machine();
    assert.equal(UNKNOWN_ORDINALS[176], 'IUnknown_QueryService');
    assert.equal(fns.IUnknown_QueryService.argBytes, 16);
    view.setUint32(0x800, 0xdead, true);
    assert.equal(await fns.IUnknown_QueryService.handler([OBJECT, 0x700, 0x710, 0x800]), 0);
    assert.equal(view.getUint32(0x800, true), 0x5150);
    assert.deepEqual(calls, [
        'QueryInterface c140516d3674ce11803400aa006009fa',
        'QueryService 700 710',
        'Release',
    ]);
    assert.equal(freed.length, 1, 'its scratch memory given back');
});

test('IUnknown_QueryService answers QueryInterface\'s refusal, and E_FAIL for nothing', async()=>{
    const { view, fns, calls, OBJECT } = machine({ provides: false });
    view.setUint32(0x800, 0xdead, true);
    assert.equal(await fns.IUnknown_QueryService.handler([OBJECT, 0x700, 0x710, 0x800]),
        E_NOINTERFACE);
    assert.equal(view.getUint32(0x800, true), 0, 'NULL written first');
    assert.equal(calls.length, 1);
    view.setUint32(0x800, 0xdead, true);
    assert.equal(await fns.IUnknown_QueryService.handler([0, 0x700, 0x710, 0x800]), E_FAIL);
    assert.equal(view.getUint32(0x800, true), 0);
    assert.equal(await fns.IUnknown_QueryService.handler([OBJECT, 0x700, 0x710, 0]), E_FAIL);
});
