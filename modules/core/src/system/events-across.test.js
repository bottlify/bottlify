/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeValue, encodeValue } from './codec.js';
import { eventFrom, plainEvent } from './events-across.js';

/** A payload across the link and back, as the run's bus hears it. @param {any} payload */
const across = payload=>eventFrom(decodeValue(encodeValue(plainEvent(payload))));

test('values cross as they are', ()=>{
    const payload = { import: 'KERNEL32.dll!Nothing', origin: 'program', count: 1,
        loaded: ['kernel32.dll', 'user32.dll'], missing: [], bytes: new Uint8Array([1, 2, 3]),
        none: null };
    assert.deepEqual(across(payload), payload);
});

test('an error is an error again, with its message, name, stack and own properties', ()=>{
    const error = Object.assign(new RangeError('out of the window'),
        { reason: 'fault', traceText: 'at 0x401000', trace: { eip: 0x401000 } });
    const heard = across({ reason: 'fault', error, text: 'at 0x401000' });
    assert.ok(heard.error instanceof Error);
    assert.equal(heard.error.name, 'RangeError');
    assert.equal(heard.error.message, 'out of the window');
    assert.equal(heard.error.stack, error.stack);
    assert.equal(heard.error.reason, 'fault');
    assert.deepEqual(heard.error.trace, { eip: 0x401000 });
    assert.equal(heard.reason, 'fault');
    assert.equal(heard.text, 'at 0x401000');
});

test('what says nothing across a thread is left out, and nothing is refused', ()=>{
    /** @type {any} */
    const looped = { name: 'a' };
    looped.self = looped;
    const shared = { at: 1 };
    const heard = across({
        handler: ()=>{}, symbol: Symbol('s'), looped, twice: [shared, shared],
        map: new Map([['a', 1]]), set: new Set([2, 3]), words: new Uint16Array([7, 8]),
        big: new Float32Array(5000), count: 10n,
    });
    assert.deepEqual(heard, {
        looped: { name: 'a' }, twice: [{ at: 1 }, { at: 1 }],
        map: [['a', 1]], set: [2, 3], words: [7, 8], count: 10,
    });
});

test('a payload that is not an object crosses as itself', ()=>{
    for (const payload of [undefined, null, 0, 'text', true])
    {
        assert.equal(across(payload), payload ?? null);
    }
});
