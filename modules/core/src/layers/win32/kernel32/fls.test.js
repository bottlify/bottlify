/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fibre-local storage against a host of plain words: indexes, a fiber's own
 * block, what is called back when, and the guest fast paths' shape. Wine's
 * fiber test (its FLS and callback cases) says what Windows answers.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createFiberLocalStorage, flsGetValueCode, flsGetValueLongCode, flsSetValueCode,
} from './fls.js';
import { TEB } from './teb.js';

const TEB_AT = 0x7ffd0000;
const ERROR_INVALID_PARAMETER = 87;

function setup(){
    /** @type {Map<number, number>} */
    const words = new Map();
    let heap = 0x00900000;
    /** @type {number[]} */
    const errors = [];
    /** @type {[number, number[]][]} */
    const calls = [];
    /** @type {number[]} */
    const freed = [];
    const storage = createFiberLocalStorage({
        readPointer: at=>words.get(at) ?? 0,
        writePointer: (at, value)=>{
            words.set(at, value);
        },
        teb: ()=>TEB_AT,
        allocate: bytes=>{
            const at = heap;
            heap += bytes;
            return at;
        },
        free: at=>{
            freed.push(at);
        },
        call: async(entry, args)=>{
            calls.push([entry, args]);
        },
        setLastError: code=>{
            errors.push(code);
        },
    });
    return { storage, fns: storage.table, words, errors, calls, freed };
}

test('index 0 is none, 1 to 127 are handed out lowest first, 128 is refused', ()=>{
    const { fns, errors } = setup();
    assert.equal(fns.FlsAlloc.handler([0]), 1);
    assert.equal(fns.FlsAlloc.handler([0]), 2);
    assert.equal(fns.FlsGetValue.handler([2]), 0, 'its caller has a block, the value NULL');
    assert.deepEqual(errors.splice(0), [0], 'and the read succeeds');
    assert.equal(fns.FlsGetValue.handler([0]), 0);
    assert.equal(fns.FlsSetValue.handler([0, 5]), 0);
    assert.equal(fns.FlsFree.handler([0]), 0);
    assert.equal(fns.FlsSetValue.handler([128, 5]), 0);
    assert.deepEqual(errors, [ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER,
        ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER]);
    assert.equal(fns.FlsFree.handler([127]), 0, 'an index nobody holds is not freed');
});

test('a value is set and read at an index nobody allocated, in a block made on the first set',
    ()=>{
        const { fns, errors, words } = setup();
        assert.equal(fns.FlsGetValue.handler([127]), 0);
        assert.deepEqual(errors, [ERROR_INVALID_PARAMETER], 'no block yet');
        assert.equal(words.get(TEB_AT + TEB.FLS_SLOTS) ?? 0, 0);
        assert.equal(fns.FlsSetValue.handler([127, 0x217]), 1);
        assert.equal(errors.length, 1, 'a write leaves the last error alone');
        assert.notEqual(words.get(TEB_AT + TEB.FLS_SLOTS) ?? 0, 0, 'FlsSlots points at it');
        assert.equal(fns.FlsGetValue.handler([127]), 0x217);
        assert.equal(errors.at(-1), 0, 'a read clears the last error');
    });

test('FlsFree calls back every block, a fiber\'s end its own block, a null value never',
    async()=>{
        const { storage, fns, calls, words, freed } = setup();
        const index = fns.FlsAlloc.handler([0x401000]);
        assert.equal(fns.FlsSetValue.handler([index, 0x1587]), 1);
        const mine = words.get(TEB_AT + TEB.FLS_SLOTS) ?? 0;
        // A second fiber's block: what SwitchToFiber leaves when it runs one
        // that has none yet.
        words.set(TEB_AT + TEB.FLS_SLOTS, 0);
        assert.equal(fns.FlsSetValue.handler([index, 0x152]), 1);
        const other = words.get(TEB_AT + TEB.FLS_SLOTS) ?? 0;
        const nulled = fns.FlsAlloc.handler([0x402000]);
        assert.equal(fns.FlsSetValue.handler([nulled, 0]), 1);

        await storage.release(other);
        assert.deepEqual(calls, [[0x401000, [0x152]]], 'the deleted fiber\'s value, once');
        assert.deepEqual(freed, [other]);

        words.set(TEB_AT + TEB.FLS_SLOTS, mine);
        calls.length = 0;
        assert.equal(await fns.FlsFree.handler([index]), 1);
        assert.deepEqual(calls, [[0x401000, [0x1587]]]);
        assert.equal(fns.FlsGetValue.handler([index]), 0, 'and the value cleared');
        assert.equal(await fns.FlsFree.handler([nulled]), 1);
        assert.equal(calls.length, 1, 'a null value is not called back');
        assert.equal(fns.FlsAlloc.handler([0]), index, 'the freed index is handed out again');
    });

test('the fast paths hand index 0, one past 127 and a missing block to the host', ()=>{
    // dec eax; cmp eax, 127; jae slow - then FlsSlots tested for null.
    const get = flsGetValueCode(0x1000, 0x2000);
    const view = new DataView(get.buffer);
    assert.deepEqual([...get.subarray(4, 10)], [0x48, 0x83, 0xf8, 0x7f, 0x73, 0x1d]);
    assert.equal(view.getUint32(13, true), TEB.FLS_SLOTS);
    assert.equal(get[get.length - 5], 0xe9);
    assert.equal(view.getInt32(get.length - 4, true), 0x2000 - (0x1000 + get.length),
        'the slow path jumps to the trap');
    const set = flsSetValueCode(0x1000, 0x2000);
    assert.deepEqual([...set.subarray(set.length - 13, set.length - 5)],
        [0xb8, 1, 0, 0, 0, 0xc2, 0x08, 0x00], 'TRUE, the last error left alone');
    const long = flsGetValueLongCode();
    assert.equal(long.code[long.jump - 1], 0xe9);
});
