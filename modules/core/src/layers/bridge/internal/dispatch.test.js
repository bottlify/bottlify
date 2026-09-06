/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Convention } from './conventions.js';
import { createParking, isParkedCall } from './parking.js';
import { createDispatcher } from './dispatch.js';

/**
 * A CPU and an address space stood in for, so these tests are about marshalling
 * and about where a result goes -- not about an emulator.
 *
 * @param {Object} [options]
 * @param {number} [options.esp]
 * @param {number[]} [options.args]
 */
function machine({ esp = 0x3000, args = [] } = {}){
    /** @type {Map<number, number>} */
    const cells = new Map([[esp, 0x401234]]);
    args.forEach((value, index)=>cells.set(esp + 4 + index * 4, value));

    /** @type {Record<string, number>} */
    const registers = { esp, ecx: 0, eax: 0 };
    const cpu = {
        /** @param {string} name */
        readReg32: name=>registers[name] ?? 0,
        /** @param {string} name @param {number} value */
        writeReg32: (name, value)=>{
            registers[name] = value;
        },
    };
    const memory = {
        /** @param {number} address */
        readU32: address=>{
            const value = cells.get(address);
            if (value === undefined)
            {
                throw new Error(`Unmapped read at ${address.toString(16)}`);
            }
            return value;
        },
        /** @param {number} address @param {number} value */
        writeU32: (address, value)=>cells.set(address, value),
    };

    /** @type {any[]} */
    const parkedThreads = [];
    const current = { name: 'caller' };
    const kernel = {
        currentThread: ()=>current,
        /** @param {any} thread */
        parkThread: thread=>parkedThreads.push(thread),
    };

    const parking = createParking({ kernel });
    const dispatcher = createDispatcher({ cpu, memory, parking });
    return { cpu, memory, registers, parking, dispatcher, parkedThreads, current };
}

test('a call is marshalled, invoked, and its result left in EAX', ()=>{
    const { dispatcher, registers } = machine({ args: [7, 5] });
    /** @type {number[][]} */
    const seen = [];

    dispatcher.register(1, {
        name: 'KERNEL32.dll!Add',
        convention: Convention.STDCALL,
        argBytes: 8,
        /** @param {number[]} args */
        handler: args=>{
            seen.push(args);
            return args[0] + args[1];
        },
    });
    dispatcher.dispatch(1);

    assert.deepEqual(seen, [[7, 5]]);
    assert.equal(registers.eax, 12);
});

test('a negative result reaches the guest as the guest reads it', ()=>{
    const { dispatcher, registers } = machine();
    dispatcher.register(1, {
        name: 'KERNEL32.dll!Fail',
        convention: Convention.STDCALL,
        argBytes: 0,
        handler: ()=>-1,
    });
    dispatcher.dispatch(1);

    // INVALID_HANDLE_VALUE and friends are written as -1 in a handler and read
    // as 0xffffffff by the guest; the conversion belongs here, once.
    assert.equal(registers.eax, 0xffffffff);
});

test('a parked call leaves EAX alone', ()=>{
    const { dispatcher, parking, registers, parkedThreads, current } = machine();
    registers.eax = 0x1234;

    dispatcher.register(1, {
        name: 'KERNEL32.dll!Wait',
        convention: Convention.STDCALL,
        argBytes: 0,
        handler: ()=>parking.park(),
    });
    dispatcher.dispatch(1);

    assert.deepEqual(parkedThreads, [current]);
    assert.equal(registers.eax, 0x1234,
        'the wait result arrives when the thread is woken; a placeholder would overwrite it');
});

test('the parked token is the only thing that means "no value yet"', ()=>{
    const { dispatcher, registers } = machine();

    // A handler that builds something token-shaped is still returning a value,
    // and the dispatcher treats it as one rather than trusting its shape.
    dispatcher.register(1, {
        name: 'KERNEL32.dll!Impostor',
        convention: Convention.STDCALL,
        argBytes: 0,
        handler: ()=>({ parked: true }),
    });
    dispatcher.dispatch(1);

    assert.equal(isParkedCall({ parked: true }), false);
    assert.equal(registers.eax, 0, 'an object is not a result; NaN >>> 0 is 0');
});

test('parking outside a call is refused rather than corrupting a stack', ()=>{
    const { parking } = machine();

    // park() rewrites the return address at ESP, which is only the caller's
    // return address while a stub's trap is being handled.
    assert.throws(()=>parking.park(), /only meaningful while a guest call is in flight/);
});

test('an unimplemented or twice-implemented trap is an error, not a guess', ()=>{
    const { dispatcher } = machine();
    const fn = {
        name: 'KERNEL32.dll!Once',
        convention: Convention.STDCALL,
        argBytes: 0,
        handler: ()=>0,
    };

    assert.throws(()=>dispatcher.dispatch(9), /trap 9 has no implementation/);
    dispatcher.register(1, fn);
    assert.throws(()=>dispatcher.register(1, fn), /already implemented/);
});

test('a handler that throws does not leave the bridge inside a call', ()=>{
    const { dispatcher, parking } = machine();
    dispatcher.register(1, {
        name: 'KERNEL32.dll!Broken',
        convention: Convention.STDCALL,
        argBytes: 0,
        handler: ()=>{
            throw new Error('boom');
        },
    });

    assert.throws(()=>dispatcher.dispatch(1), /boom/);
    // If the depth were not unwound, parking would stay legal forever after and
    // the next handler to park by mistake would be believed.
    assert.throws(()=>parking.park(), /only meaningful while a guest call is in flight/);
});

test('what the guest called is recorded in order', ()=>{
    const { dispatcher } = machine();
    for (const [id, name] of [[1, 'A'], [2, 'B']])
    {
        dispatcher.register(Number(id), {
            name: String(name),
            convention: Convention.STDCALL,
            argBytes: 0,
            handler: ()=>0,
        });
    }

    dispatcher.dispatch(1);
    dispatcher.dispatch(2);
    dispatcher.dispatch(1);

    assert.deepEqual(dispatcher.calls(), ['A', 'B', 'A']);
    assert.deepEqual(dispatcher.diagnostics(), { implemented: 2, calls: 3, lastCall: 'A' });
});
