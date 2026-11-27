/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INVALID_CRUNTIME_PARAMETER, createInvalidParameterRuntime,
    createInvalidParameterWatch, watchedExports } from './invalid-parameter.js';

const EINVAL = 22;
const ERANGE = 34;

/** A runtime whose handler calls and process ending land in `log`. */
function runtime(/** @type {any[]} */ log, threadLocal = false){
    /** @type {object} */
    let current = { name: 'main' };
    const made = createInvalidParameterRuntime({
        library: 'TEST.dll',
        threadLocal,
        callGuest: (entry, args)=>{
            log.push(['handler', entry, ...args]);
            return 0;
        },
        currentThread: ()=>current,
        exitProcess: code=>log.push(['ended', code]),
        report: (api, detail, kind)=>log.push([kind, api, detail]),
    });
    return { made, on: (/** @type {object} */ thread)=>{
        current = thread;
    } };
}

test('a function that sets EINVAL through a watched export reaches the handler, then answers',
    async()=>{
        /** @type {any[]} */
        const log = [];
        const watch = createInvalidParameterWatch();
        const { made } = runtime(log);
        const refuses = watch.within(made, 'refuses', ()=>{
            watch.note(EINVAL);
            return -1;
        });
        const succeeds = watch.within(made, 'succeeds', ()=>{
            watch.note(ERANGE);
            return 5;
        });

        made.set(0x5000);
        assert.equal(await refuses([1, 2]), -1, 'the function\'s own answer, after the handler');
        assert.deepEqual(log, [['handler', 0x5000, 0, 0, 0, 0, 0]]);
        assert.equal(succeeds([]), 5, 'another errno is no invalid parameter');
        watch.note(EINVAL);
        assert.equal(log.length, 1, 'an EINVAL outside a watched call reaches nothing');
    });

test('with no handler the process ends 0xC0000417, said as an error with the function',
    ()=>{
        /** @type {any[]} */
        const log = [];
        const watch = createInvalidParameterWatch();
        const { made } = runtime(log);
        watch.within(made, 'fopen', ()=>{
            watch.note(EINVAL);
            return 0;
        })([0, 0x40]);
        assert.deepEqual(log[1], ['ended', INVALID_CRUNTIME_PARAMETER]);
        assert.equal(log[0][0], 'loss');
        assert.match(log[0][2], /^fopen\(0x0, 0x40\): an invalid parameter and no handler set/);
    });

test('a thread\'s own handler is asked before the process\'s, each thread its own', async()=>{
    /** @type {any[]} */
    const log = [];
    const { made, on } = runtime(log, true);
    const other = { name: 'other' };
    made.set(0x5000);
    assert.equal(made.setThread?.(0x6000), 0);
    await made.raise('f', [], 0);
    on(other);
    assert.equal(made.getThread?.(), 0, 'another thread has none of its own');
    await made.raise('f', [], 0);
    assert.deepEqual(log.map(entry=>entry[1]), [0x6000, 0x5000]);
});

test('a runtime\'s exports are its calls; a runtime over another wraps the original once',
    async()=>{
    /** @type {any[]} */
        const log = [];
        const watch = createInvalidParameterWatch();
        const first = runtime(log).made;
        const second = runtime(log).made;
        second.set(0x7000);
        const plain = { convention: 'cdecl', argBytes: 0, handler: ()=>{
            watch.note(EINVAL);
            return 22;
        } };
        /** @type {any[]} */
        const registered = [];
        const guest = { convention: 'cdecl', argBytes: 0, code: (/** @type {any} */ builder)=>{
            registered.push(builder.register({ handler: plain.handler }));
            return new Uint8Array(1);
        } };
        const msvcrt = /** @type {any} */ ({ refuse: plain, alias: plain, guest, data: 5 });

        const over = watchedExports(msvcrt, watch, first);
        const top = watchedExports(over, watch, second);
        assert.equal(top.alias, top.refuse, 'a second name is the same entry');
        assert.equal(top.data, 5, 'what is no function stays as it is');
        assert.equal(msvcrt.refuse.handler([]), 22, 'msvcrt\'s own export answers EINVAL alone');
        assert.equal(log.length, 0);

        assert.equal(await top.refuse.handler([]), 22);
        assert.deepEqual(log, [['handler', 0x7000, 0, 0, 0, 0, 0]],
            'the top runtime\'s handler, not the one below it');

        // Guest code hands its refusals to the handler it registers as it is placed.
        const builder = { register: (/** @type {any} */ definition)=>definition, jump: ()=>0 };
        top.guest.code(builder);
        log.length = 0;
        await registered[0].handler([]);
        assert.deepEqual(log, [['handler', 0x7000, 0, 0, 0, 0, 0]]);
    });
