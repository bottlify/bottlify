/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROWTH, KNOWN, STAND_IN, classify, standIn, sweep } from './check-guest-pointers.mjs';

const fault = ()=>Object.assign(new Error('Unmapped read at 0x0'), { code: 'GUEST_ACCESS' });

test('a fault passes, a stand-in is not measured, anything else is a host throw', ()=>{
    assert.equal(classify(fault()), 'fault');
    assert.equal(classify(Object.assign(new Error('raised'), { code: 'GUEST_EXCEPTION' })),
        'fault', 'an exception raised in the guest on purpose');
    assert.equal(classify(Object.assign(new Error('x'), { code: STAND_IN })), 'unmeasured');
    assert.equal(classify(new TypeError('Cannot read properties of undefined')), 'throw');
    assert.equal(classify(Object.assign(new Error('An empty path names nothing'),
        { code: 'INVALID_PATH' })), 'throw');
    assert.equal(classify(Object.assign(new Error('No NUL within 255 bytes'),
        { code: 'UNTERMINATED' })), 'throw', 'a cap of the handler\'s own is no fault');
});

test('every handler is called once a set, a shared one once, and what threw is kept', async()=>{
    /** @type {string[]} */
    const called = [];
    /** @param {string} name @param {(args: number[]) => unknown} body */
    const entry = (name, body)=>({ argBytes: 8, handler: (/** @type {number[]} */ args)=>{
        called.push(`${name} ${args.join(',')}`);
        return body(args);
    } });
    const shared = entry('Shared', ()=>0);
    const libraries = {
        'A.dll': {
            Faults: entry('Faults', ([p])=>{
                if (p === 0)
                {
                    throw fault();
                }
                return 1;
            }),
            Types: entry('Types', ([p])=>(p === 0 ? /** @type {any} */ (undefined).field : 0)),
            Rejects: entry('Rejects',
                ()=>Promise.reject(new RangeError('Invalid typed array length: -1'))),
            Waits: entry('Waits', ()=>new Promise(()=>{})),
            Shared: shared,
            ExitProcess: entry('ExitProcess', ()=>{
                throw new Error('ends the process');
            }),
            NotAFunction: { argBytes: 4 },
        },
        'B.dll': { Shared: shared },
    };
    let prepared = 0;
    const result = await sweep(libraries, [['NULL', 0], ['unmapped', 0xdeadbeef]], ()=>prepared++);
    assert.equal(result.handlers, 5, 'the shared one once, the exit and the non-function never');
    assert.equal(result.calls, 10);
    assert.equal(prepared, 10, 'memory put back before every call');
    assert.deepEqual(result.offences.map(offence=>`${offence.key} ${offence.label}`),
        ['A.dll!Types NULL', 'A.dll!Rejects NULL', 'A.dll!Rejects unmapped']);
    assert.match(result.offences[1].message, /typed array length/);
    assert.ok(called.includes('Types 0,0'), 'each argument the set\'s value');
    assert.ok(!called.some(call=>call.startsWith('ExitProcess')));
});

test('a stand-in answers what it was given, and any other member is not measured', async()=>{
    const kernel = standIn('kernel', { currentThread: ()=>7 });
    assert.equal(kernel.currentThread(), 7);
    assert.throws(()=>kernel.processes.all(), (/** @type {any} */ e)=>e.code === STAND_IN
        && /kernel\.processes\.all/.test(e.message));
    const libraries = { 'C.dll': { Spawns: { argBytes: 4, handler: ()=>kernel.createThread() } } };
    const result = await sweep(libraries, [['NULL', 0]]);
    assert.deepEqual([...result.unmeasured], ['C.dll!Spawns']);
    assert.deepEqual(result.offences, []);
});

test('a call growing external memory past the bound is named, garbage before hides none', async()=>{
    /** @type {ArrayBuffer[]} */
    const held = [];
    const libraries = {
        'D.dll': {
            // Sized by the guest's length, and kept: what a handler that fills
            // a host buffer before it writes it out does for the call's length.
            Sized: { argBytes: 8, handler: ([, length])=>{
                held.push(new ArrayBuffer(length));
                return 0;
            } },
            // Made and dropped by the call before: collected, not counted
            // against the next one.
            Drops: { argBytes: 4, handler: ()=>new ArrayBuffer(GROWTH * 2).byteLength },
            Small: { argBytes: 4, handler: ()=>new ArrayBuffer(1024).byteLength },
        },
    };
    const result = await sweep(libraries, [['small', 16], ['huge', GROWTH * 2]]);
    assert.deepEqual(result.growths.map(growth=>`${growth.key} ${growth.label}`),
        ['D.dll!Sized huge', 'D.dll!Drops small', 'D.dll!Drops huge']);
    assert.ok(result.growths.every(growth=>growth.bytes >= GROWTH * 2));
    held.length = 0;
});

test('every known throw says whose it is and why', ()=>{
    for (const [key, reason] of KNOWN)
    {
        assert.match(key, /^[\w.]+\.(dll|DLL)![\w@?$]+$/, key);
        assert.ok(reason.length > 10, key);
    }
});
