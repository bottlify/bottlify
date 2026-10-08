/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExternalObject, deferredExternal, hostObject } from './external.js';
import { ForeignValue, NOTHING, plainValue } from './values.js';

test('a host object reads a number held with its subtype as a plain number', ()=>{
    /** @type {any[]} */
    const seen = [];
    const object = hostObject({ members: {
        Take: { call: args=>{
            seen.push(args);
            return 0;
        } },
        Value: { get: args=>args, put: (value, args)=>{
            seen.push([value, ...args]);
        } },
    } });
    object.call('Take', [new ForeignValue(2, 5), new ForeignValue(5, 2), NOTHING, 'x']);
    object.put('Value', new ForeignValue(3, 9), [new ForeignValue(17, 1)]);
    assert.deepEqual(seen, [[5, 2, null, 'x'], [9, 1]]);
    assert.deepEqual(object.get('value', [new ForeignValue(4, 1.5)]), [1.5]);
    assert.equal(plainValue(new ForeignValue(7, 1)).value, 1, 'a date is not a number');
});

test('what a host method stores into a by-reference argument goes back', async()=>{
    const object = hostObject({ members: {
        Fill: { call: args=>{
            args[0] = 'filled';
            args[1] = 'ignored';
            return true;
        } },
        Later: { call: args=>{
            args[0] = 2;
            return Promise.resolve('done');
        } },
    } });
    const args = ['empty', 'by value'];
    assert.equal(object.call('Fill', args, [true, false]), true);
    assert.deepEqual(args, ['filled', 'by value']);
    const later = [1];
    assert.equal(await object.call('Later', later, [true]), 'done');
    assert.deepEqual(later, [2]);
    const untouched = ['empty'];
    object.call('Fill', untouched);
    assert.deepEqual(untouched, ['empty'], 'nothing goes back without refs');
});

test('putRef is a put unless the object tells the two apart; a deferred one forwards both',
    async()=>{
        /** @type {string[]} */
        const done = [];
        const plain = hostObject({ members: { P: { put: value=>{
            done.push(`put ${value}`);
        } } } });
        await plain.putRef('P', 'a', []);
        const deferred = deferredExternal(()=>Promise.resolve(plain));
        await deferred.putRef('P', 'b', []);
        await deferred.call('P', [], [false]).catch(()=>done.push('no call'));
        assert.deepEqual(done, ['put a', 'put b', 'no call']);
        assert.ok(deferred instanceof ExternalObject);
    });
