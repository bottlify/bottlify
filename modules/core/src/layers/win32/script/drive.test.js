/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drive, isThenable } from './drive.js';
import { deferredExternal, hostObject } from './external.js';
import { oleDateToWallTime, wallTimeToOleDate } from './values.js';

test('steps that never wait finish at once, with a plain value', ()=>{
    /** @returns {Generator<unknown, number, unknown>} */
    function* inner(){
        yield 1;
        return 2;
    }
    /** @returns {Generator<unknown, unknown[], unknown>} */
    function* outer(){
        const a = yield* inner();
        const b = yield 'plain';
        return [a, b];
    }
    assert.deepEqual(drive(outer()), [2, 'plain']);
});

test('a yielded promise is waited for; its failure is thrown in at the yield', async()=>{
    /** @returns {Generator<unknown, string, any>} */
    function* steps(){
        const first = yield Promise.resolve(20);
        let caught = '';
        try
        {
            yield Promise.reject(new Error('refused'));
        }
        catch (e){
            caught = /** @type {Error} */ (e).message;
        }
        const after = yield 1;
        return `${first + after} ${caught}`;
    }
    const answer = drive(steps());
    assert.ok(isThenable(answer));
    assert.equal(await answer, '21 refused');
});

test('a failure the steps raise after waiting rejects the run', async()=>{
    /** @returns {Generator<unknown, never, unknown>} */
    function* steps(){
        yield Promise.resolve();
        throw new RangeError('own');
    }
    await assert.rejects(Promise.resolve(drive(steps())), RangeError);
});

test('a host object\'s members are matched without case', ()=>{
    const object = hostObject({ members: { Value: { get: ()=>1, put: ()=>undefined },
        Run: { call: ([x])=>x } } });
    assert.equal(object.get('VALUE', []), 1);
    assert.equal(object.call('run', [5]), 5);
    // A property is called by reading it with the arguments.
    assert.equal(object.call('value', []), 1);
    assert.throws(()=>object.get('Run', []));
    assert.equal(object.has('rUn'), true);
    assert.deepEqual(object.keys(), ['Value', 'Run']);
});

test('a deferred object loads once, when first used', async()=>{
    let loads = 0;
    const object = deferredExternal(()=>{
        loads++;
        return hostObject({ members: { A: { get: ()=>'a' } } });
    });
    assert.equal(await object.has('a'), true);
    assert.equal(await object.get('A', []), 'a');
    assert.equal(loads, 1);
    const nothing = deferredExternal(()=>null);
    assert.equal(await nothing.has('a'), false);
    await assert.rejects(Promise.resolve(nothing.get('a', [])));
});

test('automation dates: the day rounds toward zero, the time is the fraction\'s size', ()=>{
    assert.equal(oleDateToWallTime(25569), 0);
    assert.equal(oleDateToWallTime(0), Date.UTC(1899, 11, 30));
    assert.equal(oleDateToWallTime(-1.25), Date.UTC(1899, 11, 29, 6));
    assert.equal(wallTimeToOleDate(Date.UTC(1899, 11, 29, 6)), -1.25);
    assert.equal(wallTimeToOleDate(Date.UTC(2000, 0, 1, 12)), 36526.5);
    assert.ok(Number.isNaN(oleDateToWallTime(NaN)));
});
