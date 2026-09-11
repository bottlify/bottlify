/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
 * @param {{ begin: (name: string, kind?: string) => void,
 *           end: (name?: string) => number }} [options.profiler]
 */
function machine({ esp = 0x3000, args = [], profiler } = {}){
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
    const dispatcher = createDispatcher({ cpu, memory, parking, profiler });
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

test('a forwarding call reads the frame above the saved registers and restores them', ()=>{
    // The stub in front of a watched function pushed all eight registers and
    // then trapped, so ESP is 32 bytes below the caller's frame. The handler
    // sees the real arguments, and afterwards EAX and EDX are what the caller
    // set and the block is gone -- the function forwarded into is one that
    // may take its arguments in exactly those registers.
    const callerEsp = 0x3000;
    const { dispatcher, registers, memory } = machine({ esp: callerEsp, args: [0x11, 0x22] });
    registers.esp = callerEsp - 32;
    memory.writeU32(callerEsp - 32 + 28, 0xaaaa); // EAX as pushed
    memory.writeU32(callerEsp - 32 + 20, 0xdddd); // EDX as pushed
    registers.eax = 7; // the trap id, as the stub left it
    registers.edx = 0xb077; // the trap port, as the stub left it
    /** @type {any[]} */
    const seen = [];

    dispatcher.register(1, {
        name: 'Storm.dll!#279',
        convention: Convention.STDCALL,
        argBytes: 8,
        forwards: true,
        saved: 32,
        /** @param {number[]} args @param {any} frame */
        handler: (args, frame)=>{
            seen.push(args, frame.callerStack, frame.hostReturn);
            return 0;
        },
    });
    dispatcher.dispatch(1);

    assert.deepEqual(seen, [[0x11, 0x22], callerEsp, 0x401234]);
    assert.equal(registers.esp, callerEsp, 'the saved block is dropped');
    assert.equal(registers.eax, 0xaaaa);
    assert.equal(registers.edx, 0xdddd);
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
    const { implemented, calls, lastCall, hot } = dispatcher.diagnostics();
    assert.deepEqual({ implemented, calls, lastCall }, { implemented: 2, calls: 3, lastCall: 'A' });
    assert.deepEqual(hot, [['A', 2], ['B', 1]], 'and what it called most, commonest first');
});

test('the call log is bounded, and a long run does not grow it', ()=>{
    // Diagnostics must not scale with how well the engine works. A program that
    // runs for an hour makes hundreds of millions of calls; kept as a list this
    // ends as a failure inside the dispatcher whose message is about array
    // length and says nothing about the guest.
    const { dispatcher } = machine();
    dispatcher.register(1, {
        name: 'Tick',
        convention: Convention.STDCALL,
        argBytes: 0,
        handler: ()=>0,
    });

    for (let at = 0; at < 10000; at++)
    {
        dispatcher.dispatch(1);
    }

    assert.equal(dispatcher.diagnostics().calls, 10000, 'every call is still counted');
    assert.equal(dispatcher.calls().length, 4096, 'but only the recent ones are kept');
    assert.equal(dispatcher.recent(3).length, 3);
    assert.equal(dispatcher.diagnostics().lastCall, 'Tick');
});

test('the crossing is timed apart from the handler it carries', ()=>{
    // A title's menu makes about thirty thousand of these a second while every
    // handler in a report costs a fraction of a millisecond a frame. Without
    // the boundary timed on its own there is no way to tell a machine slowed by
    // its own emulation from one slowed by leaving it so often -- and the two
    // want opposite fixes.
    /** @type {string[]} */
    const opened = [];
    const built = machine({
        profiler: {
            /** @param {string} name */
            begin: name=>opened.push(`begin ${name}`),
            /** @param {string} [name] */
            end: name=>opened.push(`end ${name}`),
        },
    });
    built.dispatcher.register(1, {
        name: 'TEST.dll!Something', convention: 'stdcall', argBytes: 0, handler: ()=>7,
    });
    built.dispatcher.dispatch(1);

    assert.deepEqual(opened, [
        'begin trap',
        'begin TEST.dll!Something',
        'end TEST.dll!Something',
        'end trap',
    ], 'the handler runs inside the crossing, so the crossing keeps only its own time');
});

test('a call sink is handed the record as recorded, with nothing peeked for it', ()=>{
    // Peeking every argument for a string, for a sink that does not read
    // strings, cost more than the rest of the dispatch together. With tracing
    // off the sink gets the arguments and no strings, and guest memory is not
    // read past the arguments themselves.
    const m = machine({ args: [0x5000, 0x6000] });
    /** @type {number[]} */
    const reads = [];
    /** @type {any} */
    const memory = {
        ...m.memory,
        /** @param {number} address */
        readU8: address=>{
            reads.push(address);
            return 0;
        },
    };
    /** @type {any[]} */
    const seen = [];
    const dispatcher = createDispatcher({
        cpu: m.cpu, memory, parking: m.parking,
        onCall: (/** @type {any} */ call)=>seen.push(call),
    });
    dispatcher.register(3, { name: 'X.dll!F', convention: 'stdcall', argBytes: 8, handler: ()=>1 });

    dispatcher.dispatch(3);

    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].args, [0x5000, 0x6000]);
    assert.equal(seen[0].strings, null, 'no strings without tracing');
    assert.deepEqual(reads, [], 'and no byte of guest memory was peeked');
});
