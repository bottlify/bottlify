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
import { WRITER_COLUMNS, createWriterAccount } from '../../memory/internal/writers.js';
import { createTable, readTable } from '../../log/internal/table.js';

/**
 * A CPU and an address space stood in for, so these tests are about marshalling
 * and about where a result goes -- not about an emulator.
 *
 * @param {Object} [options]
 * @param {number} [options.esp]
 * @param {number[]} [options.args]
 * @param {{ begin: (name: string, kind?: string) => void,
 *           end: (name?: string) => number }} [options.profiler]
 * @param {boolean} [options.callPhases]
 * @param {() => number} [options.lastError]
 * @param {number} [options.ecx]
 * @param {Record<string, Function>} [options.memoryExtras]
 *     What the memory layer answers beyond reads and writes -- the writer
 *     account, where a test is about attribution.
 * @param {any} [options.journal]  Where a hook's crossings are written.
 * @param {() => number} [options.now]  The clock call rates are measured by.
 */
function machine(options = {}){
    const {
        esp = 0x3000, args = [], profiler, callPhases = false, lastError, ecx = 0, journal, now,
    } = options;
    /** @type {Map<number, number>} */
    const cells = new Map([[esp, 0x401234]]);
    args.forEach((value, index)=>cells.set(esp + 4 + index * 4, value));

    /** @type {Record<string, number>} */
    const registers = { esp, ecx, eax: 0 };
    const cpu = {
        /** @param {string} name */
        readReg32: name=>registers[name] ?? 0,
        /** @param {string} name @param {number} value */
        writeReg32: (name, value)=>{
            registers[name] = value;
        },
    };
    const memory = {
        ...options.memoryExtras,
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
        /**
         * @param {number} address @param {number} count
         * @param {number[]} into @param {number} [at]
         */
        readU32sInto: (address, count, into, at = 0)=>{
            for (let word = 0; word < count; word++)
            {
                const value = cells.get(address + word * 4);
                if (value === undefined)
                {
                    throw new Error(`Unmapped read at ${(address + word * 4).toString(16)}`);
                }
                into[at + word] = value | 0;
            }
        },
        /** @param {number} address @param {number} length */
        window: (address, length)=>{
            const bytes = new Uint8Array(length);
            const view = new DataView(bytes.buffer);
            for (let at = 0; at < length; at += 4)
            {
                const value = cells.get(address + at);
                if (value === undefined)
                {
                    throw new Error(`Unmapped read at ${(address + at).toString(16)}`);
                }
                view.setUint32(at, value >>> 0, true);
            }
            return bytes;
        },
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
    const dispatcher = createDispatcher({
        cpu, memory, parking, profiler, callPhases, lastError, journal, now,
        suspend: ()=>{},
    });
    return { cpu, memory, registers, parking, dispatcher, parkedThreads, current };
}

/** A handler description with the shape the module registers. */
const STDCALL = { convention: Convention.STDCALL };

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
            seen.push(args.slice());
            return args[0] + args[1];
        },
    });
    dispatcher.dispatch(1);

    assert.deepEqual(seen, [[7, 5]]);
    assert.equal(registers.eax, 12);
});

test('arguments arrive signed, as the guest pushed them', ()=>{
    // Guest code pushes 32-bit words; a handler that wants an unsigned value
    // says so itself. Silently widening here would make -1 and 0xffffffff
    // different values to a handler that compares against one of them.
    const { dispatcher } = machine({ args: [0xffffffff] });
    let seen = 0;
    dispatcher.register(1, {
        name: 'X!Signed', ...STDCALL, argBytes: 4,
        /** @param {number[]} args */
        handler: ([value])=>{
            seen = value;
            return 0;
        },
    });
    dispatcher.dispatch(1);
    assert.equal(seen, -1);
});

test('thiscall takes `this` from ECX and the rest from the stack; cdecl pops nothing', ()=>{
    const { dispatcher } = machine({ args: [22, 33], ecx: 0x401000 });
    /** @type {number[][]} */
    const seen = [];
    /** @type {number[]} */
    const resting = [];
    dispatcher.register(1, {
        name: 'X!Method', convention: Convention.THISCALL, argBytes: 12,
        /** @param {number[]} args @param {{ restingStack: number }} frame */
        handler: (args, frame)=>{
            seen.push(args.slice());
            resting.push(frame.restingStack);
            return 0;
        },
    });
    dispatcher.register(2, {
        name: 'X!printf', convention: Convention.CDECL, argBytes: 8,
        /** @param {number[]} args @param {{ restingStack: number }} frame */
        handler: (args, frame)=>{
            seen.push(args.slice());
            resting.push(frame.restingStack);
            return 0;
        },
    });
    dispatcher.dispatch(1);
    dispatcher.dispatch(2);
    assert.deepEqual(seen, [[0x401000, 22, 33], [22, 33]],
        '`this` comes first in declaration order even though it never was on the stack');
    // The return address and what the callee pops: eight bytes for the
    // thiscall (`this` was never pushed), nothing for cdecl.
    assert.deepEqual(resting, [0x3000 + 4 + 8, 0x3000 + 4]);
});

test('a prompt call allocates nothing: the arguments, the frame and the record are reused', ()=>{
    // Thirty thousand crossings a second in a menu, a thousand a frame in a
    // battle: an object per call here is the garbage collector's share of
    // the frame. The handler is given the dispatcher's own arrays, which are
    // written over on the next call -- so what it keeps, it copies.
    const { dispatcher } = machine({ args: [1, 2, 3] });
    /** @type {any[]} */
    const givenArgs = [];
    /** @type {any[]} */
    const givenFrames = [];
    dispatcher.register(1, {
        name: 'X!Three', ...STDCALL, argBytes: 12,
        /** @param {number[]} args @param {any} frame */
        handler: (args, frame)=>{
            givenArgs.push(args);
            givenFrames.push(frame);
            return 0;
        },
    });
    dispatcher.dispatch(1);
    dispatcher.dispatch(1);
    assert.equal(givenArgs[0], givenArgs[1], 'the same argument array both times');
    assert.equal(givenFrames[0], givenFrames[1], 'and the same frame');
    assert.deepEqual(givenArgs[1], [1, 2, 3]);
    const [first, second] = dispatcher.detailed(2);
    assert.notEqual(first, second, 'a reader gets a copy each');
    assert.deepEqual([first.result, second.result], ['0x0', '0x0']);
});

test('a call that answers later keeps its arguments; the next call gets fresh ones', ()=>{
    // A handler that parks or returns a promise reads its arguments after
    // the dispatcher has moved on. Writing the next call's arguments into the
    // array it holds would hand it another call's values, silently.
    const { dispatcher, parking } = machine({ args: [5] });
    /** @type {any[]} */
    const givenArgs = [];
    /** @type {any[]} */
    const givenFrames = [];
    let park = false;
    dispatcher.register(1, {
        name: 'X!Maybe', ...STDCALL, argBytes: 4,
        /** @param {number[]} args @param {any} frame */
        handler: (args, frame)=>{
            givenArgs.push(args);
            givenFrames.push(frame);
            return park ? parking.park() : Promise.resolve(1);
        },
    });
    dispatcher.dispatch(1);
    dispatcher.dispatch(1);
    assert.notEqual(givenArgs[0], givenArgs[1], 'after a promise, a new array');
    assert.notEqual(givenFrames[0], givenFrames[1], 'and a new frame');
    park = true;
    dispatcher.dispatch(1);
    assert.notEqual(givenArgs[1], givenArgs[2], 'after parking too');
    assert.deepEqual(givenArgs[0], [5], 'what the first call was given is still its own');
    const [waiting, parked] = dispatcher.detailed(3).slice(1);
    assert.deepEqual([waiting.result, parked.result], ['waiting', 'parked']);
});

test('the last error is read after a call that can set it, and not after one that cannot', ()=>{
    // A COM method answers with an HRESULT and never touches the thread's
    // error, and there are a thousand of them a frame; the read is a trip
    // into another layer for a value that did not change.
    let reads = 0;
    const { dispatcher } = machine({ lastError: ()=>{
        reads++;
        return 87;
    } });
    dispatcher.register(1, {
        name: 'KERNEL32.dll!CreateFileA', ...STDCALL, argBytes: 0, handler: ()=>0,
    });
    dispatcher.register(2, {
        name: '{IID}::SetTexture', ...STDCALL, argBytes: 0, handler: ()=>0, lastError: false,
    });
    dispatcher.dispatch(1);
    dispatcher.dispatch(2);
    assert.equal(reads, 1);
    const [plain, com] = dispatcher.detailed(2);
    assert.equal(plain.error, 87);
    assert.equal(com.error, 0, 'nothing to report, rather than a stale reading');
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
            seen.push(args.slice(), frame.callerStack, frame.hostReturn);
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

test('the detail ring names, argues and answers each call it still holds once it has come round',
    ()=>{
        const m = machine({ args: [7, 9] });
        m.dispatcher.register(1, { name: 'X!Two', ...STDCALL, argBytes: 8, handler: ()=>2 });
        m.dispatcher.register(2, { name: 'X!None', ...STDCALL, argBytes: 0, handler: ()=>-1 });
        /** @type {any[]} */
        const seenInFlight = [];
        m.dispatcher.register(3, {
            name: 'X!Looks', ...STDCALL, argBytes: 0,
            handler: ()=>{
                seenInFlight.push(m.dispatcher.detailed(1)[0]);
                return 3;
            },
        });
        for (let at = 0; at < 4096 * 2 + 5; at++)
        {
            m.memory.writeU32(0x3004, at % 1000);
            m.dispatcher.dispatch(at % 2 === 0 ? 1 : 2);
        }
        m.dispatcher.dispatch(3);

        const last = m.dispatcher.detailed(4);
        assert.deepEqual(last.map(call=>[call.name, call.args, call.result]), [
            ['X!Two', [194, 9], '0x2'],
            ['X!None', [], '0xffffffff'],
            ['X!Two', [196, 9], '0x2'],
            ['X!Looks', [], '0x3'],
        ]);
        assert.equal(m.dispatcher.detailed().length, 4096);
        assert.deepEqual(m.dispatcher.recent(2), ['X!Two', 'X!Looks']);
        assert.equal(seenInFlight[0].name, 'X!Looks', 'a call in flight is in the ring already');
        assert.equal(seenInFlight[0].kind, 'threw',
            'and reads as unfinished, not as the call its slot held before');
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
    for (let call = 0; call < 8000; call++)
    {
        built.dispatcher.dispatch(1);
    }
    assert.ok(opened.every((line, i)=>line === (i % 2 === 0 ? 'begin trap' : 'end trap')),
        'the crossing is timed; the call is not, unless a measurement asks');
    const timed = opened.length / 2;
    assert.ok(timed > 200 && timed < 300,
        `one crossing in thirty-two is timed (${timed} of 8000)`);

    opened.length = 0;
    const phased = machine({
        profiler: {
            /** @param {string} name */
            begin: name=>opened.push(`begin ${name}`),
            /** @param {string} [name] @param {{ weight?: number }} [detail] */
            end: (name, detail)=>opened.push(
                `end ${name}${detail?.weight ? ` x${detail.weight}` : ''}`),
        },
        callPhases: true,
    });
    phased.dispatcher.register(1, {
        name: 'TEST.dll!Something', convention: 'stdcall', argBytes: 0, handler: ()=>7,
    });
    while (!opened.includes('begin trap'))
    {
        phased.dispatcher.dispatch(1);
    }
    assert.deepEqual(opened.slice(-4), [
        'begin trap',
        'begin TEST.dll!Something',
        'end TEST.dll!Something',
        'end trap x32',
    ], 'asked for, the handler runs inside the crossing, which keeps only its own time');
    assert.equal(opened.filter(line=>line === 'begin TEST.dll!Something').length,
        opened.length / 2 - 1, 'and every call is timed, the untimed crossings\' too');
});

test('work inside a call is timed with the crossing and stands for as many', ()=>{
    // The shadow's sync runs at every host call before the device method; a
    // clock of its own there would cost what sampling the crossing saved. It
    // is timed when the crossing is, inside it, and carries its weight.
    /** @type {string[]} */
    const opened = [];
    /** @param {boolean} callPhases @param {boolean} [profiled] */
    const build = (callPhases, profiled = true)=>{
        const built = machine({
            callPhases,
            profiler: profiled ? {
                /** @param {string} name */
                begin: name=>opened.push(`begin ${name}`),
                /**
                 * @param {string} [name]
                 * @param {{ weight?: number, withParent?: boolean }} [detail]
                 */
                end: (name, detail)=>opened.push(`end ${name}`
                    + `${detail?.weight ? ` x${detail.weight}` : ''}`
                    + `${detail?.withParent ? ' with parent' : ''}`),
            } : undefined,
        });
        const { dispatcher } = built;
        dispatcher.register(1, {
            name: 'TEST.dll!Draw', convention: 'stdcall', argBytes: 0, handler: ()=>{
                const weight = dispatcher.innerBegin('ring-sync');
                dispatcher.innerEnd('ring-sync', weight);
                return 0;
            },
        });
        return dispatcher;
    };

    const sampled = build(false);
    for (let call = 0; call < 4000; call++)
    {
        sampled.dispatch(1);
    }
    const crossings = opened.filter(line=>line === 'begin trap').length;
    assert.ok(crossings > 0);
    assert.equal(opened.filter(line=>line === 'begin ring-sync').length, crossings,
        'timed exactly when the crossing is');
    for (let at = 0; at < opened.length; at += 4)
    {
        assert.deepEqual(opened.slice(at, at + 4), ['begin trap', 'begin ring-sync',
            'end ring-sync x32 with parent', 'end trap x32']);
    }

    opened.length = 0;
    const everyCall = build(true);
    for (let call = 0; call < 100; call++)
    {
        everyCall.dispatch(1);
    }
    assert.equal(opened.filter(line=>line === 'end ring-sync').length, 100,
        'with every call a phase, every call\'s work is timed and stands for itself');

    opened.length = 0;
    const none = build(false, false);
    for (let call = 0; call < 100; call++)
    {
        none.dispatch(1);
    }
    assert.deepEqual(opened, [], 'no profiler, nothing opened');
});

test('a crossing made from inside a timed one times nothing inside it', ()=>{
    // A callback into the guest from a timed call that calls the host again:
    // the inner crossing is not timed, and work timed inside it would be
    // charged to the outer one's weight -- thirty-two times what it was.
    /** @type {string[]} */
    const opened = [];
    const { dispatcher } = machine({
        profiler: {
            /** @param {string} name */
            begin: name=>opened.push(`begin ${name}`),
            /** @param {string} [name] */
            end: name=>opened.push(`end ${name}`),
        },
    });
    /** @type {number[]} */
    const untimed = [];
    let weight = -1;
    dispatcher.register(2, {
        name: 'TEST.dll!Inner', convention: 'stdcall', argBytes: 0, handler: ()=>{
            weight = dispatcher.innerBegin('ring-sync');
            dispatcher.innerEnd('ring-sync', weight);
            return 0;
        },
    });
    dispatcher.register(1, {
        name: 'TEST.dll!Outer', convention: 'stdcall', argBytes: 0, handler: ()=>{
            if (opened.at(-1) === 'begin trap')
            {
                const before = opened.length;
                dispatcher.dispatch(2);
                // Only an inner crossing the sampler did not pick itself.
                if (opened[before] !== 'begin trap')
                {
                    untimed.push(weight);
                }
            }
            return 0;
        },
    });
    for (let call = 0; call < 4000 && untimed.length < 8; call++)
    {
        dispatcher.dispatch(1);
    }
    assert.equal(untimed.length, 8);
    assert.deepEqual(untimed, new Array(8).fill(0));
});

test('which crossing is timed does not follow the program\'s own sequence of calls', ()=>{
    // A frame's draws repeat one sequence of calls. Timing every eighth call
    // of a sequence whose length shares a factor with eight times the same
    // positions of it every time, and the estimate is those calls' cost
    // weighted eightfold: here, the one heavy call of eight, timed always or
    // never.
    /** @type {string[]} */
    const timed = [];
    let inside = false;
    const built = machine({
        profiler: {
            begin: ()=>{
                inside = true;
            },
            end: ()=>{
                inside = false;
                return 0;
            },
        },
    });
    built.dispatcher.register(1, {
        name: 'TEST.dll!Heavy', convention: 'stdcall', argBytes: 0,
        handler: ()=>(inside && timed.push('heavy'), 0),
    });
    built.dispatcher.register(2, {
        name: 'TEST.dll!Light', convention: 'stdcall', argBytes: 0,
        handler: ()=>(inside && timed.push('light'), 0),
    });
    for (let sequence = 0; sequence < 2000; sequence++)
    {
        built.dispatcher.dispatch(1);
        for (let light = 0; light < 7; light++)
        {
            built.dispatcher.dispatch(2);
        }
    }
    const heavy = timed.filter(name=>name === 'heavy').length / timed.length;
    assert.ok(heavy > 0.08 && heavy < 0.17,
        `the heavy call is an eighth of the timed ones, as of the calls (${heavy.toFixed(3)})`);
});

test('the detail ring hands out copies, and its records are written over, not remade', ()=>{
    // A record and an argument array per call, thirty thousand times a second,
    // was the garbage collector's whole share of a frame. The ring's records
    // are reused, so what a reader was given has to be a copy that the next
    // call cannot change.
    const m = machine({ args: [1, 2] });
    m.dispatcher.register(1, {
        name: 'TEST.dll!First', convention: 'stdcall', argBytes: 8, handler: ()=>1,
    });
    m.dispatcher.dispatch(1);
    const [first] = m.dispatcher.detailed(1);
    assert.deepEqual(first.args, [1, 2]);
    assert.equal(first.name, 'TEST.dll!First');

    m.memory.writeU32(0x3004, 9);
    m.memory.writeU32(0x3008, 8);
    m.dispatcher.register(2, {
        name: 'TEST.dll!Second', convention: 'stdcall', argBytes: 8, handler: ()=>2,
    });
    m.dispatcher.dispatch(2);
    assert.deepEqual(first.args, [1, 2], 'the copy handed out earlier is untouched');
    assert.equal(first.name, 'TEST.dll!First');
    const [older, newer] = m.dispatcher.detailed(2);
    assert.equal(older.name, 'TEST.dll!First');
    assert.deepEqual(newer.args, [9, 8]);
    assert.equal(newer.result, '0x2');
});

test('a record reused by a call of another arity has that call\'s arguments and no more', ()=>{
    // The ring's record keeps its argument array while the count stays; a
    // call with fewer or more arguments gets one of its own length.
    const m = machine({ args: [1, 2] });
    m.dispatcher.register(1, {
        name: 'TEST.dll!Two', convention: 'stdcall', argBytes: 8, handler: ()=>1,
    });
    m.dispatcher.register(2, {
        name: 'TEST.dll!None', convention: 'stdcall', argBytes: 0, handler: ()=>2,
    });
    m.dispatcher.dispatch(1);
    m.dispatcher.dispatch(2);
    m.dispatcher.dispatch(1);
    const [two, none, again] = m.dispatcher.detailed(3);
    assert.deepEqual(two.args, [1, 2]);
    assert.deepEqual(none.args, []);
    assert.deepEqual(again.args, [1, 2]);
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
        find: address=>{
            reads.push(address);
            return undefined;
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
    assert.equal(seen[0].result, '0x1');
    assert.equal(seen[0].strings, null, 'no strings without tracing');
    assert.deepEqual(reads, [], 'and no byte of guest memory was peeked');
});

test('tracing peeks through the region map and never through a read that throws', ()=>{
    // Most arguments above the peek floor are constants and handles that
    // point at nothing. Asking the map costs a lookup; reading and catching
    // cost a formatted error and a stack per argument, which with tracing on
    // was several times the whole crossing.
    const text = 'C:/App/game.cfg';
    const bytes = new Uint8Array(64);
    bytes.set([...text].map(c=>c.charCodeAt(0)));
    const m = machine({ args: [0x2300, 0x7000, 0x7ff8] });
    let windows = 0;
    /** @type {any} */
    const memory = {
        ...m.memory,
        /** @param {number} address */
        find: address=>(address >= 0x7000 && address < 0x8000
            ? { name: 'data', base: 0x7000, size: 0x1000, access: 'rw' }
            : undefined),
        /** @param {number} address @param {number} length */
        window: (address, length)=>{
            // The argument marshalling's own window, over the stack this
            // test's base machine already answers for -- distinct from the
            // peek below, which is what this test counts.
            if (address < 0x7000)
            {
                return m.memory.window(address, length);
            }
            windows++;
            assert.ok(address + length <= 0x8000, 'a peek never runs past its region');
            return bytes.subarray(address - 0x7000, address - 0x7000 + length);
        },
        /** @param {number} address */
        readU8: address=>{
            throw new Error(`Unmapped read at ${address.toString(16)}`);
        },
    };
    /** @type {any[]} */
    const seen = [];
    const dispatcher = createDispatcher({
        cpu: m.cpu, memory, parking: m.parking, traceStrings: true,
        onCall: (/** @type {any} */ call)=>seen.push({ strings: call.strings.slice() }),
    });
    dispatcher.register(3, {
        name: 'X.dll!F', convention: 'stdcall', argBytes: 12, handler: ()=>1,
    });

    dispatcher.dispatch(3);
    dispatcher.dispatch(3);

    assert.deepEqual(seen[0].strings, [null, text, null],
        'the constant is not a pointer, the string is read, the tail of the region is clamped');
    assert.equal(windows, 4, 'one window per mapped argument per call, none for the constant');
    assert.deepEqual(seen[1].strings, seen[0].strings);
    assert.deepEqual(dispatcher.detailed(1)[0].strings, [null, text, null]);
});

test('a string longer than a peek is shown cut short, not as nothing', ()=>{
    // An installer's paths run past the peek; an empty slot in a trace read
    // as a call made with no path at all.
    const text = `C:\\${'Deep\\'.repeat(40)}file.dll`;
    const bytes = new Uint8Array(0x1000);
    bytes.set([...text].map(c=>c.charCodeAt(0)));
    const m = machine({ args: [0x7000] });
    /** @type {any} */
    const memory = {
        ...m.memory,
        find: (/** @type {number} */ address)=>(address >= 0x7000 && address < 0x8000
            ? { name: 'data', base: 0x7000, size: 0x1000, access: 'rw' } : undefined),
        window: (/** @type {number} */ address, /** @type {number} */ length)=>(address < 0x7000
            ? m.memory.window(address, length)
            : bytes.subarray(address - 0x7000, address - 0x7000 + length)),
    };
    const dispatcher = createDispatcher({ cpu: m.cpu, memory, parking: m.parking,
        traceStrings: true });
    dispatcher.register(3, { name: 'X.dll!F', convention: 'stdcall', argBytes: 4,
        handler: ()=>1 });
    dispatcher.dispatch(3);
    const [shown] = dispatcher.detailed(1)[0].strings;
    assert.ok(shown?.endsWith('…') && text.startsWith(shown.slice(0, -1)), String(shown));
});

test('a waiting call is reported to the sink twice: once as asked, once as answered', async()=>{
    const m = machine({ args: [1, 2] });
    /** @type {any[]} */
    const seen = [];
    const dispatcher = createDispatcher({
        cpu: m.cpu, memory: m.memory, parking: m.parking, suspend: ()=>{},
        onCall: (/** @type {any} */ call)=>seen.push({ ...call }),
    });
    dispatcher.register(3, {
        name: 'X.dll!Read', ...STDCALL, argBytes: 8, handler: ()=>Promise.resolve(0x40),
    });
    dispatcher.dispatch(3);
    await Promise.resolve();
    assert.deepEqual(seen.map(call=>call.result), ['waiting', '0x40 (was waiting)']);
    assert.deepEqual(seen[1].args, [1, 2], 'the second line carries what was asked');
});

test('a call reaches the sink with its thread, and a waiting one\'s answer with the thread that'
    + ' asked, though another runs when it comes', async()=>{
    const m = machine({ args: [1, 2] });
    /** @type {any[]} */
    const seen = [];
    /** @type {(value: number) => void} */
    let answer = ()=>{};
    const dispatcher = createDispatcher({
        cpu: m.cpu, memory: m.memory, parking: m.parking, suspend: ()=>{},
        onCall: (/** @type {any} */ call)=>seen.push(`${call.result} on ${call.thread}`),
    });
    dispatcher.register(3, {
        name: 'X.dll!Wait', ...STDCALL, argBytes: 8,
        handler: ()=>new Promise(resolve=>{
            answer = resolve;
        }),
    });
    dispatcher.register(4, { name: 'X.dll!F', ...STDCALL, argBytes: 8, handler: ()=>1 });
    dispatcher.dispatch(3);
    m.current.name = 'other';
    dispatcher.dispatch(4);
    answer(0x40);
    await Promise.resolve();
    assert.deepEqual(seen, ['waiting on caller', '0x1 on other', '0x40 (was waiting) on caller']);
});

test('a waiting call that fails is reported to the sink, not left unhandled', async()=>{
    // The sink's own continuation on the answer had no rejection handler, so
    // a handler that awaited and then threw brought the host process down
    // before whoever suspended the call could report the failure.
    const m = machine({ args: [1, 2] });
    /** @type {any[]} */
    const seen = [];
    const dispatcher = createDispatcher({
        cpu: m.cpu, memory: m.memory, parking: m.parking, suspend: ()=>{},
        onCall: (/** @type {any} */ call)=>seen.push({ ...call }),
    });
    dispatcher.register(3, {
        name: 'X.dll!Read', ...STDCALL, argBytes: 8,
        handler: ()=>Promise.reject(new Error('later')),
    });
    dispatcher.dispatch(3);
    await Promise.resolve();
    assert.deepEqual(seen.map(call=>[call.kind, call.result]),
        [['waiting', 'waiting'], ['threw', 'threw (was waiting)']]);
});

test('a write into guest memory is charged to the call in flight, however it nests', ()=>{
    // The real account over a real table, so this tests the crossing's hook
    // against the layer that will answer it rather than against a spy.
    /** @type {string[]} */
    const words = [];
    const table = createTable({ rows: 8, columns: WRITER_COLUMNS, shared: false });
    const account = createWriterAccount({
        table,
        intern: text=>{
            const at = words.indexOf(text);
            return at >= 0 ? at : words.push(text) - 1;
        },
    });
    const { dispatcher, memory } = machine({
        args: [1],
        memoryExtras: { writer: account.writer, charging: account.charging },
    });

    dispatcher.register(1, {
        name: 'A', convention: Convention.STDCALL, argBytes: 4,
        handler: ()=>{
            account.charge(10);
            // What a handler that calls the guest back does: the guest traps
            // into another host call, which must not keep the charge.
            dispatcher.dispatch(2);
            account.charge(1);
            return 0;
        },
    });
    dispatcher.register(2, {
        name: 'B', convention: Convention.STDCALL, argBytes: 4,
        handler: ()=>{
            account.charge(100);
            return 0;
        },
    });

    // A write before anything is in flight, and one after everything returned.
    account.charge(5);
    dispatcher.dispatch(1);
    account.charge(7);
    void memory;

    const rows = Object.fromEntries(readTable(table.describe()).all()
        .filter(row=>row.writes > 0)
        .map(row=>[words[row.name], [row.bytes, row.writes]]));
    assert.deepEqual(rows, {
        '<no host call>': [12, 2],
        A: [11, 2],
        B: [100, 1],
    });
});

test('fastcall reads this live and the first argument from the pushed word', ()=>{
    // The trap sequence's own `mov dx, port` spends the low half of EDX
    // before any handler runs, so a plain live read would hand a fastcall
    // handler a stomped second argument -- it comes from what the stub's
    // `push edx` saved first instead, the marshalling this test pins. ECX
    // needs no such care: nothing in the trap sequence touches it.
    const esp = 0x3000;
    // Three stack words behind the registers.
    const m = machine({ esp, args: [7, 8, 9], ecx: 0x1111 });
    const pushed = esp - 4; // where a push-edx stub traps from
    m.registers.esp = pushed;
    m.memory.writeU32(pushed, 0x2222); // EDX as the stub pushed it (dst)
    m.registers.edx = 0xb077; // what the trap sequence left behind: not this
    /** @type {number[][]} */
    const seen = [];
    m.dispatcher.register(1, {
        name: 'vector.dot', convention: Convention.FASTCALL, argBytes: 20,
        saved: 4, hook: true, target: 0x24e450,
        /** @param {number[]} args */
        handler: args=>{
            seen.push(args.slice());
            return true;
        },
    });
    m.dispatcher.dispatch(1);
    assert.deepEqual(seen, [[0x1111, 0x2222, 7, 8, 9]],
        'this, then dst, then the three stack words, in declaration order');
});

test('a hook that answers the call returns to the caller as `ret cleanup` would', ()=>{
    const esp = 0x3000;
    const m = machine({ esp, args: [7, 8, 9], ecx: 0x1111 });
    const pushed = esp - 4;
    m.registers.esp = pushed;
    m.memory.writeU32(pushed, 0x2222);
    m.dispatcher.register(1, {
        name: 'vector.dot', convention: Convention.FASTCALL, argBytes: 20,
        saved: 4, hook: true, target: 0x24e450,
        handler: ()=>true,
    });
    m.dispatcher.dispatch(1);
    assert.equal(m.registers.ecx, 0x1111, 'never touched, so still what the guest passed');
    assert.equal(m.registers.edx, 0x2222, 'restored to what the guest actually passed');
    assert.equal(m.registers.esp, esp + 4 + 12,
        'the return address and the 12-byte cleanup, both popped');
    assert.equal(m.registers.eip, 0x401234, 'the return address `readU32sInto`\'s stub cell holds');
});

test('a hook that does not handle the call falls through to the original target', ()=>{
    const esp = 0x3000;
    const m = machine({ esp, args: [7, 8, 9], ecx: 0x1111 });
    const pushed = esp - 4;
    m.registers.esp = pushed;
    m.memory.writeU32(pushed, 0x2222);
    m.dispatcher.register(1, {
        name: 'vector.dot', convention: Convention.FASTCALL, argBytes: 20,
        saved: 4, hook: true, target: 0x24e450,
        handler: ()=>false,
    });
    m.dispatcher.dispatch(1);
    assert.equal(m.registers.ecx, 0x1111, 'the guest function sees its own call, unmarred');
    assert.equal(m.registers.edx, 0x2222);
    assert.equal(m.registers.esp, esp, 'not popped: the target function will do its own `ret`');
    assert.equal(m.registers.eip, 0x24e450, 'redirected into the guest\'s own function');
});

test('a hook\'s own counters and a reported mismatch land in its diagnostics', ()=>{
    const esp = 0x3000;
    const m = machine({ esp, args: [1, 2, 3], ecx: 0x1111 });
    const pushed = esp - 4;
    m.registers.esp = pushed;
    m.memory.writeU32(pushed, 0x2222);
    let answer = false;
    m.dispatcher.register(1, {
        name: 'vector.dot', convention: Convention.FASTCALL, argBytes: 20,
        saved: 4, hook: true, target: 0x24e450,
        handler: ()=>answer,
    });
    m.dispatcher.dispatch(1); // fell through
    answer = true;
    m.registers.esp = pushed; // the previous call moved it; a fresh guest call would too
    m.dispatcher.dispatch(1); // handled
    m.dispatcher.reportMismatch('vector.dot');
    const [hook] = m.dispatcher.hooks();
    assert.ok(hook.ms >= 0, `two prompt handler calls read as ${hook.ms}ms`);
    assert.deepEqual({ ...hook, ms: undefined }, {
        name: 'vector.dot', calls: 2, handled: 1, fellThrough: 1, mismatches: 1, ms: undefined,
    });
    // A name nothing registered is a question nobody can answer to, not a throw.
    m.dispatcher.reportMismatch('nothing.here');
});

test('a hook\'s `ms` times the handler call itself, and a fallthrough still accrues it', ()=>{
    const esp = 0x3000;
    const m = machine({ esp, args: [1, 2, 3], ecx: 0x1111 });
    const pushed = esp - 4;
    // Long enough to be measurable, far shorter than the tick `Date.now`
    // moves in -- the same margin `layers/log/module.test.js` spins for.
    const spin = ()=>{
        const until = performance.now() + 0.2;
        while (performance.now() < until)
        {
            // Deliberately empty: the point is the wall time, not the work.
        }
    };
    let answer = false;
    m.dispatcher.register(1, {
        name: 'vector.dot', convention: Convention.FASTCALL, argBytes: 20,
        saved: 4, hook: true, target: 0x24e450,
        handler: ()=>{
            spin();
            return answer;
        },
    });
    m.registers.esp = pushed;
    m.memory.writeU32(pushed, 0x2222);
    m.dispatcher.dispatch(1); // fell through, and still spent the 0.2ms
    const [afterFallthrough] = m.dispatcher.hooks();
    assert.ok(afterFallthrough.ms >= 0.2,
        `a fellThrough call that spun 0.2ms read as ${afterFallthrough.ms}ms`);

    answer = true;
    m.registers.esp = pushed; // the previous call moved it; a fresh guest call would too
    m.memory.writeU32(pushed, 0x2222);
    m.dispatcher.dispatch(1); // handled, another 0.2ms on top
    const [afterHandled] = m.dispatcher.hooks();
    assert.ok(afterHandled.ms >= afterFallthrough.ms + 0.2,
        `a second, handled call should add its own 0.2ms; read ${afterFallthrough.ms}ms `
        + `then ${afterHandled.ms}ms`);
});

test('with call.hook on, a hook writes the frame before its handler and the redirect after', ()=>{
    const esp = 0x3000;
    /** @type {string[]} */
    const written = [];
    const journal = {
        Level: { TRACE: 5 },
        /** @param {string} category @param {number} level */
        enabled: (category, level)=>category === 'call.hook' && level === 5,
        /**
         * @param {number} level @param {string} category @param {string} message
         * @param {...any} args
         */
        write: (level, category, message, ...args)=>{
            written.push(message.replace(/\{(\d)\}/g, (_, i)=>String(args[Number(i)])));
        },
    };
    const m = machine({ esp, args: [7, 8, 9], ecx: 0x1111, journal });
    const pushed = esp - 4;
    m.registers.esp = pushed;
    m.memory.writeU32(pushed, 0x2222);
    m.dispatcher.register(1, {
        name: 'vector.dot', convention: Convention.FASTCALL, argBytes: 20,
        saved: 4, hook: true, target: 0x24e450,
        // The entry record must already be there when the handler runs: it is
        // the account of a handler that never comes back.
        handler: ()=>{
            assert.equal(written.length, 1);
            return false;
        },
    });
    m.dispatcher.dispatch(1);
    assert.deepEqual(written, [
        'vector.dot entry esp=0x3000 ret=0x401234 args=0x1111,0x2222,0x7,0x8,0x9',
        'vector.dot fellThrough eip=0x24e450 esp=0x3000',
    ]);
});

test('with call.hook off, a hook writes nothing', ()=>{
    const esp = 0x3000;
    let written = 0;
    const journal = {
        Level: { TRACE: 5 },
        enabled: ()=>false,
        write: ()=>{
            written++;
        },
    };
    const m = machine({ esp, args: [7, 8, 9], ecx: 0x1111, journal });
    m.registers.esp = esp - 4;
    m.memory.writeU32(esp - 4, 0x2222);
    m.dispatcher.register(1, {
        name: 'vector.dot', convention: Convention.FASTCALL, argBytes: 20,
        saved: 4, hook: true, target: 0x24e450, handler: ()=>true,
    });
    m.dispatcher.dispatch(1);
    assert.equal(written, 0);
});

test('a five-argument stdcall makes zero window calls, one readU32sInto call, ' +
    'and constructs zero DataViews', ()=>{
    // The old path was five reads with a region check and a cache lookup
    // each, then a `memory.window` + `DataView` per call; the crossing now
    // makes one call into the memory layer and allocates nothing of its own.
    // The return address at ESP is the first word of the same span.
    const esp = 0x3000;
    const m = machine({ esp, args: [10, 20, 30, 40, 50] });
    let windows = 0;
    let readU32sIntoCalls = 0;
    /** @type {any} */
    const memory = {
        ...m.memory,
        /** @param {number} address @param {number} length */
        window: (address, length)=>{
            windows++;
            return m.memory.window(address, length);
        },
        /**
         * @param {number} address @param {number} count
         * @param {number[]} into @param {number} [at]
         */
        readU32sInto: (address, count, into, at = 0)=>{
            readU32sIntoCalls++;
            m.memory.readU32sInto(address, count, into, at);
        },
    };
    const RealDataView = globalThis.DataView;
    let dataViews = 0;
    globalThis.DataView = /** @type {any} */ (class extends RealDataView {
        constructor(/** @type {any[]} */ ...args){
            dataViews++;
            super(.../** @type {[ArrayBufferLike, number?, number?]} */ (args));
        }
    });
    /** @type {number[][]} */
    const seen = [];
    try
    {
        const dispatcher = createDispatcher({ cpu: m.cpu, memory, parking: m.parking });
        dispatcher.register(1, {
            name: 'X.dll!Five', ...STDCALL, argBytes: 20,
            /** @param {number[]} args */
            handler: args=>{
                seen.push(args.slice());
                return 0;
            },
        });

        dispatcher.dispatch(1);
    }
    finally
    {
        globalThis.DataView = RealDataView;
    }

    assert.deepEqual(seen, [[10, 20, 30, 40, 50]], 'the arguments arrive in order');
    assert.equal(windows, 0, 'no window call for the stack words');
    assert.equal(readU32sIntoCalls, 1,
        'one readU32sInto call for the return address and the arguments');
    assert.equal(dataViews, 0, 'no DataView constructed by the crossing');
});

/**
 * A site hook's stub trapped with a full `pushad`: `saved: 32`, so the
 * dispatcher's own `esp` local (`pushed + entry.saved`) lands back at the
 * site's own ESP, the value pushad itself recorded at `pushed + 12`.
 *
 * @param {number} siteEsp
 * @param {{ eax?: number, ecx?: number, edx?: number, ebx?: number,
 *     ebp?: number, esi?: number, edi?: number }} [values]
 */
function pushSiteRegisters(siteEsp, values = {}){
    const {
        eax = 0x7000, ecx = 0x6000, edx = 0x5000, ebx = 0x4000,
        ebp = 0x3000, esi = 0x2000, edi = 0x1000,
    } = values;
    const pushed = siteEsp - 32;
    return { pushed, eax, ecx, edx, ebx, ebp, esi, edi };
}

test('a site hook reads all eight registers off the pushad block into a plain object', ()=>{
    const siteEsp = 0x3000;
    const { pushed, eax, ecx, edx, ebx, ebp, esi, edi } = pushSiteRegisters(siteEsp);
    const m = machine({ esp: siteEsp });
    m.registers.esp = pushed;
    m.memory.writeU32(pushed + 0, edi);
    m.memory.writeU32(pushed + 4, esi);
    m.memory.writeU32(pushed + 8, ebp);
    m.memory.writeU32(pushed + 12, siteEsp); // esp, as pushad itself recorded it
    m.memory.writeU32(pushed + 16, ebx);
    m.memory.writeU32(pushed + 20, edx);
    m.memory.writeU32(pushed + 24, ecx);
    m.memory.writeU32(pushed + 28, eax);
    /** @type {any[]} */
    const seen = [];
    m.dispatcher.register(1, {
        name: 'loop.faces', site: true, saved: 32,
        trampoline: 0x900000, resume: 0x901000, stackAdjust: 8,
        /** @param {import('./dispatch.js').SiteRegisters} registers */
        handler: registers=>{
            seen.push({ ...registers });
            return false;
        },
    });
    m.dispatcher.dispatch(1);
    assert.deepEqual(seen, [{ eax, ecx, edx, ebx, esp: siteEsp, ebp, esi, edi }]);
});

test('a site hook that answers writes back every edited register, ESP by stackAdjust, '
    + 'EIP to resume', ()=>{
    const siteEsp = 0x3000;
    const { pushed, eax, ecx, ebx, esi, edi } = pushSiteRegisters(siteEsp);
    const m = machine({ esp: siteEsp });
    m.registers.esp = pushed;
    // Seeded non-zero, unlike the registers the handler below edits: a
    // register the handler never touches must still be written back with
    // exactly the value the pushad block held, which zero-filling this block
    // could not have told apart from the write-back being deleted entirely.
    m.memory.writeU32(pushed + 0, edi);
    m.memory.writeU32(pushed + 4, esi);
    m.memory.writeU32(pushed + 8, 0);
    m.memory.writeU32(pushed + 12, siteEsp);
    m.memory.writeU32(pushed + 16, ebx);
    m.memory.writeU32(pushed + 20, 0);
    m.memory.writeU32(pushed + 24, ecx);
    m.memory.writeU32(pushed + 28, eax);
    m.dispatcher.register(1, {
        name: 'loop.faces', site: true, saved: 32,
        trampoline: 0x900000, resume: 0x901000, stackAdjust: 8,
        /** @param {import('./dispatch.js').SiteRegisters} registers */
        handler: registers=>{
            // The kernel's own answer: only EBP (the count) and EDX (what the
            // resume point's own next instruction would have loaded) are
            // meaningful for this loop, but every register is still written
            // back -- the mechanism does not know which ones a kernel cares
            // about.
            registers.ebp = 42;
            registers.edx = 0x12345678;
            registers.esp += 4; // a handler may move the stack itself
            return true;
        },
    });
    m.dispatcher.dispatch(1);
    assert.equal(m.registers.ebp, 42);
    assert.equal(m.registers.edx, 0x12345678);
    assert.equal(m.registers.eax, eax,
        'a register the handler never touched is still written back with its seeded value');
    assert.equal(m.registers.ecx, ecx);
    assert.equal(m.registers.ebx, ebx);
    assert.equal(m.registers.esi, esi);
    assert.equal(m.registers.edi, edi);
    assert.equal(m.registers.esp, siteEsp + 4 + 8,
        'the handler\'s own esp edit, then stackAdjust on top of it');
    assert.equal(m.registers.eip, 0x901000, 'moved to resume');
});

test('a site hook that falls through restores every register to what the site held, '
    + 'even if the handler edited the object it was given', ()=>{
    const siteEsp = 0x3000;
    const { pushed, eax, ecx, edx, ebx, ebp, esi, edi } = pushSiteRegisters(siteEsp);
    const m = machine({ esp: siteEsp });
    m.registers.esp = pushed;
    m.memory.writeU32(pushed + 0, edi);
    m.memory.writeU32(pushed + 4, esi);
    m.memory.writeU32(pushed + 8, ebp);
    m.memory.writeU32(pushed + 12, siteEsp);
    m.memory.writeU32(pushed + 16, ebx);
    m.memory.writeU32(pushed + 20, edx);
    m.memory.writeU32(pushed + 24, ecx);
    m.memory.writeU32(pushed + 28, eax);
    m.dispatcher.register(1, {
        name: 'loop.faces', site: true, saved: 32,
        trampoline: 0x900000, resume: 0x901000, stackAdjust: 8,
        /** @param {import('./dispatch.js').SiteRegisters} registers */
        handler: registers=>{
            // A kernel that decided partway through to fall through -- its
            // guard fired after it had already started editing -- must leave
            // nothing behind: the mechanism restores from the pristine
            // reading, not from whatever this object now holds.
            registers.ebp = 999999;
            registers.esp = 0;
            return false;
        },
    });
    m.dispatcher.dispatch(1);
    assert.deepEqual(
        { eax: m.registers.eax, ecx: m.registers.ecx, edx: m.registers.edx,
            ebx: m.registers.ebx, ebp: m.registers.ebp, esi: m.registers.esi,
            edi: m.registers.edi },
        { eax, ecx, edx, ebx, ebp, esi, edi });
    assert.equal(m.registers.esp, siteEsp, 'the site\'s own esp, not the handler\'s edit');
    assert.equal(m.registers.eip, 0x900000, 'moved to the trampoline');
});

test('a site hook shares a slot hook\'s counters and diagnostics', ()=>{
    const siteEsp = 0x3000;
    const { pushed } = pushSiteRegisters(siteEsp);
    const m = machine({ esp: siteEsp });
    m.registers.esp = pushed;
    for (let at = 0; at < 32; at += 4)
    {
        m.memory.writeU32(pushed + at, 0);
    }
    let answer = false;
    m.dispatcher.register(1, {
        name: 'loop.faces', site: true, saved: 32,
        trampoline: 0x900000, resume: 0x901000, stackAdjust: 8,
        handler: ()=>answer,
    });
    m.dispatcher.dispatch(1); // fell through
    answer = true;
    m.registers.esp = pushed; // the previous call moved it; a fresh site call would too
    m.dispatcher.dispatch(1); // handled
    m.dispatcher.reportMismatch('loop.faces');
    const [hook] = m.dispatcher.hooks();
    assert.ok(hook.ms >= 0, `two prompt handler calls read as ${hook.ms}ms`);
    assert.deepEqual({ ...hook, ms: undefined }, {
        name: 'loop.faces', calls: 2, handled: 1, fellThrough: 1, mismatches: 1, ms: undefined,
    });
});

test('with call.hook on, a site hook writes the frame before its handler and the '
    + 'redirect after', ()=>{
    const siteEsp = 0x3000;
    const { pushed } = pushSiteRegisters(siteEsp);
    /** @type {string[]} */
    const written = [];
    const journal = {
        Level: { TRACE: 5 },
        /** @param {string} category @param {number} level */
        enabled: (category, level)=>category === 'call.hook' && level === 5,
        /**
         * @param {number} level @param {string} category @param {string} message
         * @param {...any} args
         */
        write: (level, category, message, ...args)=>{
            written.push(message.replace(/\{(\d)\}/g, (_, i)=>String(args[Number(i)])));
        },
    };
    const m = machine({ esp: siteEsp, journal });
    m.registers.esp = pushed;
    for (let at = 0; at < 32; at += 4)
    {
        m.memory.writeU32(pushed + at, 0);
    }
    m.dispatcher.register(1, {
        name: 'loop.faces', site: true, saved: 32,
        trampoline: 0x900000, resume: 0x901000, stackAdjust: 8,
        handler: ()=>{
            assert.equal(written.length, 1);
            return false;
        },
    });
    m.dispatcher.dispatch(1);
    assert.equal(written.length, 2);
    // The trace's `esp=` is the dispatcher's own `esp` local -- the site's own
    // ESP, `pushed + saved` -- the same field a slot hook's trace uses; `ret=`
    // is whatever the guest's own stack held at that address, which for a
    // site hook is not a return address at all (there was no call), just a
    // number the trace carries unchanged.
    assert.match(written[0], /^loop\.faces entry esp=0x3000 /);
    assert.deepEqual(written[1],
        'loop.faces fellThrough eip=0x900000 esp=0x3000');
});

test('a variadic call near the top of the stack reads what is there and zero past it', ()=>{
    // printf reads a fixed number of slots for its variable arguments; a call
    // from a thread's first frame has fewer words than that above it, and
    // past the stack is nothing the caller passed.
    const top = 0x3010;
    const m = machine({
        esp: 0x3000,
        args: [0x11, 0x22, 0x33],
        memoryExtras: {
            /** @param {number} address */
            find: address=>(address >= 0x2000 && address < top
                ? { base: 0x2000, size: top - 0x2000 } : null),
        },
    });
    /** @type {number[]} */
    let seen = [];
    m.dispatcher.register(1, {
        name: 'msvcrt.dll!printf',
        convention: Convention.CDECL,
        argBytes: 6 * 4,
        /** @param {number[]} args */
        handler: args=>{
            seen = args.slice();
            return 0;
        },
    });

    m.dispatcher.dispatch(1);

    assert.deepEqual(seen, [0x11, 0x22, 0x33, 0, 0, 0]);
});

test('a read that fails inside no region at all still fails', ()=>{
    const m = machine({ esp: 0x3000, args: [1], memoryExtras: { find: ()=>null } });
    m.dispatcher.register(1, {
        name: 'X.dll!Y', convention: Convention.CDECL, argBytes: 8, handler: ()=>0,
    });

    assert.throws(()=>m.dispatcher.dispatch(1), /Unmapped read/);
});

test('two dispatchers\' records answer through one getter, so they share a hidden class', ()=>{
    // A getter of each dispatcher's own made each machine's records a class of
    // their own, and the crossing's code -- one compilation for every machine
    // in a process -- met a second machine's records as strangers and wrote
    // their fields through the generic path.
    /** @param {ReturnType<typeof machine>} m */
    const recordOf = m=>{
        /** @type {any} */
        let kept = null;
        const dispatcher = createDispatcher({
            cpu: m.cpu, memory: m.memory, parking: m.parking,
            onCall: record=>{
                kept = record;
            },
        });
        dispatcher.register(1, { name: 'X.dll!Y', ...STDCALL, argBytes: 0, handler: ()=>5 });
        dispatcher.dispatch(1);
        return kept;
    };
    const first = recordOf(machine());
    const second = recordOf(machine());

    assert.notEqual(first, second);
    assert.deepEqual(Object.keys(first), Object.keys(second));
    assert.equal(Object.getOwnPropertyDescriptor(first, 'result')?.get,
        Object.getOwnPropertyDescriptor(second, 'result')?.get, 'one getter for both');
    assert.equal(second.result, '0x5');
});

test('a register file lent by the cpu carries ESP and EAX, and one that reads empty is asked '
    + 'for again', ()=>{
    const m = machine({ esp: 0x3000, args: [7, 5] });
    /** @type {Int32Array} */
    let file = new Int32Array(8);
    file[4] = 0x3000;
    let lent = 0;
    /** @type {string[]} */
    const byName = [];
    const cpu = {
        registerFile: ()=>{
            lent++;
            return file;
        },
        /** @param {string} name */
        readReg32: name=>{
            byName.push(`read ${name}`);
            return m.cpu.readReg32(name);
        },
        /** @param {string} name @param {number} value */
        writeReg32: (name, value)=>{
            byName.push(`write ${name}`);
            m.cpu.writeReg32(name, value);
        },
    };
    const dispatcher = createDispatcher({ cpu, memory: m.memory, parking: m.parking });
    dispatcher.register(1, {
        name: 'X.dll!Sub', ...STDCALL, argBytes: 8,
        /** @param {number[]} args */
        handler: ([a, b])=>a - b - 10,
    });

    dispatcher.dispatch(1);
    assert.equal(file[0], -8, 'EAX written in place, as the guest reads it');
    assert.deepEqual(byName, [], 'neither register asked for by name');
    assert.equal(lent, 1);

    // What an emulator growing its memory does to the view it lent.
    const moved = new Int32Array(8);
    moved[4] = 0x3000;
    /** @type {any} */ (file.buffer).transfer();
    file = moved;
    dispatcher.dispatch(1);
    assert.equal(lent, 2, 'a view that reads empty is asked for again');
    assert.equal(moved[0], -8);

    const none = machine({ esp: 0x3000, args: [7, 5] });
    const refusing = createDispatcher({
        cpu: { ...none.cpu, registerFile: ()=>null }, memory: none.memory, parking: none.parking,
    });
    refusing.register(1, {
        name: 'X.dll!Sub', ...STDCALL, argBytes: 8,
        /** @param {number[]} args */
        handler: ([a, b])=>a - b,
    });
    refusing.dispatch(1);
    assert.equal(none.registers.eax, 2, 'a cpu that lends none is answered by name');
});

test('the last error is read from the calling thread\'s block at the offset handed down, and '
    + 'through lastError for a thread without one', ()=>{
    const m = machine({ esp: 0x3000 });
    /** @type {string[]} */
    const read = [];
    m.memory.writeU32(0x7034, 0x57);
    const cpu = {
        ...m.cpu,
        /** @param {number} address */
        readU32: address=>{
            read.push(`cpu ${address.toString(16)}`);
            return m.memory.readU32(address);
        },
    };
    /** @type {number[]} */
    const errors = [];
    const dispatcher = createDispatcher({
        cpu, memory: m.memory, parking: m.parking, lastErrorOffset: 0x34,
        lastError: ()=>{
            read.push('lastError');
            return 0x12;
        },
        onCall: record=>errors.push(record.error),
    });
    dispatcher.register(1, { name: 'X.dll!Y', ...STDCALL, argBytes: 0, handler: ()=>0 });
    dispatcher.register(2, {
        name: 'X.dll!Z', ...STDCALL, argBytes: 0, handler: ()=>0, lastError: false,
    });

    /** @type {any} */ (m.current).tebAddress = 0x7000;
    dispatcher.dispatch(1);
    dispatcher.dispatch(2);
    /** @type {any} */ (m.current).tebAddress = 0;
    dispatcher.dispatch(1);

    assert.deepEqual(errors, [0x57, 0, 0x12]);
    assert.deepEqual(read, ['cpu 7034', 'lastError'],
        'the block read where there is one, the reader where there is none, neither for a '
        + 'function that cannot set it');
});

test('every dispatcher crosses through one set of functions, the class\'s', ()=>{
    // A crossing each machine made of its own closures was optimised afresh
    // for each: a later machine's ran unoptimised until hot again, then on
    // code compiled around what the machines before it had left.
    const first = machine().dispatcher;
    const second = machine().dispatcher;
    for (const name of /** @type {const} */ (['dispatch', 'dispatchNow', 'register']))
    {
        assert.equal(first[name], second[name], `${name} is one function for both`);
        assert.equal(Object.hasOwn(first, name), false, `${name} is not the instance's own`);
    }
});

test('a reader lent by the memory layer carries the stack words and the thread\'s last error',
    ()=>{
        // The memory layer's reads are methods of one class for the realm;
        // its api's own and the cpu's under them are closures of each
        // machine, which a process's later machines paid for on every call.
        const m = machine({ esp: 0x3000, args: [7, 5] });
        /** @type {string[]} */
        const asked = [];
        const reader = {
            /**
             * @param {number} address @param {number} count
             * @param {number[]} into @param {number} at
             */
            readU32sInto: (address, count, into, at)=>{
                asked.push(`words 0x${address.toString(16)} ${count}`);
                m.memory.readU32sInto(address, count, into, at);
            },
            /** @param {number} address */
            readU32: address=>{
                asked.push(`dword 0x${address.toString(16)}`);
                return 0x57;
            },
        };
        const memory = {
            ...m.memory,
            reader: ()=>reader,
            readU32sInto: ()=>{
                throw new Error('not through the memory layer\'s api');
            },
        };
        const cpu = {
            ...m.cpu,
            readU32: ()=>{
                throw new Error('nor through the cpu\'s');
            },
        };
        /** @type {number[]} */
        const errors = [];
        const dispatcher = createDispatcher({
            cpu, memory, parking: m.parking, lastErrorOffset: 0x34, lastError: ()=>0,
            onCall: record=>errors.push(record.error),
        });
        dispatcher.register(1, {
            name: 'X.dll!Sub', ...STDCALL, argBytes: 8,
            /** @param {number[]} args */
            handler: ([a, b])=>a - b,
        });
        /** @type {any} */ (m.current).tebAddress = 0x7000;
        dispatcher.dispatch(1);

        assert.equal(m.registers.eax, 2);
        assert.deepEqual(asked, ['words 0x3000 3', 'dword 0x7034']);
        assert.deepEqual(errors, [0x57]);
    });

test('the charge slot lent by the memory layer is swapped in around a call, nested or thrown, '
    + 'and put back', ()=>{
    const m = machine({ esp: 0x3000 });
    const slot = new Int32Array(1);
    slot[0] = 1;
    const writers = { 'X.dll!Outer': 5, 'X.dll!Inner': 6, 'X.dll!Fails': 7 };
    const memory = {
        ...m.memory,
        /** @param {string} name */
        writer: name=>writers[/** @type {keyof typeof writers} */ (name)],
        chargeSlot: ()=>slot,
        charging: ()=>{
            throw new Error('no call into the memory layer where there is a slot');
        },
    };
    /** @type {number[]} */
    const seen = [];
    const dispatcher = createDispatcher({ cpu: m.cpu, memory, parking: m.parking });
    dispatcher.register(1, {
        name: 'X.dll!Outer', ...STDCALL, argBytes: 0,
        handler: ()=>{
            seen.push(slot[0]);
            dispatcher.dispatch(2);
            seen.push(slot[0]);
            return 0;
        },
    });
    dispatcher.register(2, {
        name: 'X.dll!Inner', ...STDCALL, argBytes: 0,
        handler: ()=>{
            seen.push(slot[0]);
            return 0;
        },
    });
    dispatcher.register(3, {
        name: 'X.dll!Fails', ...STDCALL, argBytes: 0,
        handler: ()=>{
            seen.push(slot[0]);
            throw new Error('the handler failed');
        },
    });

    dispatcher.dispatch(1);
    assert.throws(()=>dispatcher.dispatch(3), /the handler failed/);
    assert.deepEqual(seen, [5, 6, 5, 7], 'each call charged while it runs, the outer again after');
    assert.equal(slot[0], 1, 'whoever was charged before the calls is charged after them');
});

test('a sink that says which calls it wants is handed those alone, and asked again when the '
    + 'journal\'s revision moves', async()=>{
    const m = machine({ esp: 0x3000 });
    const revision = new Int32Array(1);
    /** @type {string[]} */
    const asked = [];
    let traced = new Set(['X.dll!Y']);
    /** @type {string[]} */
    const sunk = [];
    const journal = {
        enabled: ()=>false, write: ()=>{}, Level: { TRACE: 0 }, revisionCell: ()=>revision,
    };
    const dispatcher = createDispatcher({
        cpu: m.cpu, memory: m.memory, parking: m.parking, journal, suspend: ()=>{},
        onCall: record=>sunk.push(`${record.name} ${record.result}`),
        wantsCall: name=>{
            asked.push(name);
            return traced.has(name);
        },
    });
    dispatcher.register(1, { name: 'X.dll!Y', ...STDCALL, argBytes: 0, handler: ()=>1 });
    dispatcher.register(2, { name: 'X.dll!Z', ...STDCALL, argBytes: 0, handler: ()=>2 });
    /** @type {(value: number) => void} */
    let answer = ()=>{};
    dispatcher.register(3, {
        name: 'X.dll!Later', ...STDCALL, argBytes: 0,
        handler: ()=>new Promise(settle=>{
            answer = settle;
        }),
    });

    for (const id of [1, 2, 1, 2, 3])
    {
        dispatcher.dispatch(id);
    }
    answer(9);
    await Promise.resolve();
    assert.deepEqual(sunk, ['X.dll!Y 0x1', 'X.dll!Y 0x1'],
        'the wanted calls alone, and not the answer of a waiting one nobody wants');
    assert.deepEqual(asked, ['X.dll!Y', 'X.dll!Z', 'X.dll!Later'], 'each function asked once');

    traced = new Set(['X.dll!Z']);
    revision[0]++;
    dispatcher.dispatch(1);
    dispatcher.dispatch(2);
    assert.deepEqual(sunk.slice(2), ['X.dll!Z 0x2']);
    assert.deepEqual(asked.slice(3), ['X.dll!Y', 'X.dll!Z'], 'and asked again once it moved');

    // The ring keeps every call whoever the sink wants.
    assert.deepEqual(dispatcher.calls(), ['X.dll!Y', 'X.dll!Z', 'X.dll!Y', 'X.dll!Z',
        'X.dll!Later', 'X.dll!Y', 'X.dll!Z']);
});

test('a sink with no revision to ask again by is handed every call', ()=>{
    const m = machine({ esp: 0x3000 });
    /** @type {string[]} */
    const sunk = [];
    const dispatcher = createDispatcher({
        cpu: m.cpu, memory: m.memory, parking: m.parking,
        onCall: record=>sunk.push(record.name),
        wantsCall: ()=>false,
    });
    dispatcher.register(1, { name: 'X.dll!Y', ...STDCALL, argBytes: 0, handler: ()=>1 });
    dispatcher.dispatch(1);
    dispatcher.dispatch(1);
    assert.deepEqual(sunk, ['X.dll!Y', 'X.dll!Y']);
});

test('the report counts every call by function and charges each the host time sampled', ()=>{
    const m = machine();
    m.dispatcher.register(1, { name: 'X!Often', ...STDCALL, argBytes: 0, handler: ()=>0 });
    m.dispatcher.register(2, { name: 'X!Once', ...STDCALL, argBytes: 0, handler: ()=>0 });
    for (let call = 0; call < 500; call++)
    {
        m.dispatcher.dispatch(1);
    }
    m.dispatcher.dispatch(2);
    const report = m.dispatcher.diagnostics();
    const rows = report.byFunction.map((/** @type {string} */ row)=>row.split(' ').slice(0, 2));
    assert.deepEqual(rows.find((/** @type {string[]} */ row)=>row[0] === 'X!Often'), ['X!Often', '500']);
    assert.deepEqual(rows.find((/** @type {string[]} */ row)=>row[0] === 'X!Once'), ['X!Once', '1']);
    assert.ok(report.hostMs >= 0);
});

test('a function called too often a second is named, in the report and once in the journal', ()=>{
    // A program that starts going to the host for ever -- polling a query
    // that will not answer, spinning on a message -- shows as it starts.
    let clock = 0;
    /** @type {any[][]} */
    const written = [];
    const journal = {
        enabled: ()=>false,
        /** @param {any[]} line */
        write: (...line)=>written.push(line),
        Level: { TRACE: 0, WARN: 3 },
    };
    const { dispatcher } = machine({ now: ()=>clock, journal });
    dispatcher.register(1, { name: 'USER32.dll!PeekMessageA', ...STDCALL, argBytes: 0,
        handler: ()=>0 });
    dispatcher.register(2, { name: 'KERNEL32.dll!Sleep', ...STDCALL, argBytes: 0,
        handler: ()=>0 });
    for (let call = 0; call < 25000; call++)
    {
        dispatcher.dispatch(1);
    }
    dispatcher.dispatch(2);
    assert.deepEqual(dispatcher.diagnostics().chatty, [], 'no whole second measured yet');
    clock = 1000;
    const chatty = dispatcher.diagnostics().chatty;
    assert.equal(chatty.length, 1, 'Sleep, called once, is not named');
    assert.match(chatty[0], /^USER32\.dll!PeekMessageA 2500\d\/s \d+ms\/s$/);
    assert.equal(written.length, 1);
    assert.equal(written[0][0], 3, 'a warning');
    assert.equal(written[0][1], 'call.chatty');

    clock = 2000;
    for (let call = 0; call < 25000; call++)
    {
        dispatcher.dispatch(1);
    }
    clock = 3000;
    dispatcher.diagnostics();
    assert.equal(written.length, 1, 'written to the journal once, however long it goes on');
});

test('a function kept out of the ring of recent calls is counted but not kept there', ()=>{
    // app.debug.callRingSkip: an idle loop's few calls kept out, so that the
    // calls around one moment are still there to read.
    const { dispatcher } = machine({ args: [1, 2] });
    const add = { convention: Convention.STDCALL, argBytes: 8, handler: ()=>0 };
    dispatcher.register(1, { ...add, name: 'USER32.dll!ShowWindow' });
    dispatcher.register(2, { ...add, name: 'USER32.dll!PeekMessageA' });
    dispatcher.register(3, { ...add, name: 'USER32.dll!DestroyWindow' });
    assert.deepEqual(dispatcher.skipInRing(['ShowWindow', 'PeekMessage']),
        ['USER32.dll!ShowWindow', 'USER32.dll!PeekMessageA'], 'a width left off matches both');
    for (const id of [1, 2, 3, 1, 2])
    {
        dispatcher.dispatch(id);
    }
    assert.deepEqual(dispatcher.detailed().map((/** @type {any} */ call)=>call.name),
        ['USER32.dll!DestroyWindow']);
    assert.equal(dispatcher.diagnostics().calls, 5, 'every call still counted');
    dispatcher.skipInRing([]);
    dispatcher.dispatch(1);
    assert.equal(dispatcher.detailed().at(-1).name, 'USER32.dll!ShowWindow',
        'and none, once cleared');
});

/**
 * A 64-bit machine: its registers quadwords, its calls the x64 convention's,
 * RDX's first argument kept in R11 by the stub.
 *
 * @param {Record<string, bigint>} [set]
 */
function longMachine(set = {}){
    const rsp = 0x8000;
    /** @type {Map<string, bigint>} */
    const r = new Map(Object.entries({ rsp: BigInt(rsp), rax: 0n, ...set }));
    const cpu = {
        bits: ()=>64,
        /** @param {string} name */
        readReg64: name=>r.get(name) ?? 0n,
        /** @param {string} name @param {bigint} value */
        writeReg64: (name, value)=>r.set(name, value),
        /** @param {string} name */
        readReg32: name=>Number((r.get(name === 'esp' ? 'rsp' : name) ?? 0n) & 0xffffffffn),
        writeReg32: ()=>{},
    };
    const memory = {
        /** @param {number} address */
        readU32: address=>(address === rsp ? 0x401234 : 0),
        writeU32: ()=>{},
    };
    const kernel = { currentThread: ()=>({ name: 'main' }), parkThread: ()=>{} };
    const dispatcher = createDispatcher({ cpu, memory, parking: createParking({ kernel }),
        suspend: ()=>{} });
    return { dispatcher, r };
}

test('a 64-bit caller finds a quadword the handler answers in two halves whole in RAX', ()=>{
    // GetTickCount64, _lseeki64, _atoi64: the 32-bit way of answering a
    // quadword is EDX:EAX, and a 64-bit caller reads RAX alone. Sign-extending
    // EAX instead would lose any high half and invent one for a low half
    // with its top bit set.
    const { dispatcher, r } = longMachine({ rcx: 7n, r11: 0xffffffffn });
    /** @type {number[][]} */
    const seen = [];
    dispatcher.register(1, { name: 'X!Wide', ...STDCALL, argBytes: 8,
        /** @param {number[]} args */
        handler: args=>{
            seen.push(args.slice());
            dispatcher.answerHigh(1);
            return 0x80000000;
        } });
    dispatcher.register(2, { name: 'X!Narrow', ...STDCALL, argBytes: 0, handler: ()=>-1 });
    dispatcher.register(3, { name: 'X!Unsigned', ...STDCALL, argBytes: 0,
        handler: ()=>0x80000000 });

    dispatcher.dispatch(1);
    assert.deepEqual(seen, [[7, -1]], 'RCX and the RDX the stub kept in R11, each a dword');
    assert.equal(r.get('rax'), 0x180000000n);
    dispatcher.dispatch(2);
    assert.equal(r.get('rax'), 0xffffffffffffffffn, 'a dword answer is sign-extended');
    dispatcher.dispatch(3);
    assert.equal(r.get('rax'), 0xffffffff80000000n,
        'and the high half one call gave is not the next call\'s');
});

test('a quadword argument is one x64 slot, split into the two dwords the handler reads', ()=>{
    // _lseeki64(int fd, __int64 offset, int origin): four dwords to a 32-bit
    // handler, three arguments to an x86-64 caller -- RCX, RDX and R8.
    const { dispatcher } = longMachine({ rcx: 3n, r11: 0x100000005n, r8: 2n });
    /** @type {number[][]} */
    const seen = [];
    dispatcher.register(1, { name: 'X!Seek', ...STDCALL, argBytes: 16, quadwords: [1],
        /** @param {number[]} args */
        handler: args=>(seen.push(args.slice()), 0) });
    dispatcher.dispatch(1);
    assert.deepEqual(seen, [[3, 5, 1, 2]]);

    // Past the four registers a quadword is a stack slot whole, its high half
    // the slot's second dword.
    const stack = longMachine({ rcx: 1n, r11: 2n, r8: 3n, r9: 4n });
    /** @type {Map<number, number>} */
    const words = new Map([[0x8000, 0x401234], [0x8028, 5], [0x8030, 0xfffffffe],
        [0x8034, 0xffffffff], [0x8038, 7]]);
    /** @type {any} */ (stack.dispatcher).memory = {
        /** @param {number} address */
        readU32: address=>words.get(address) ?? 0, writeU32: ()=>{} };
    stack.dispatcher.register(2, { name: 'X!Late', ...STDCALL, argBytes: 32, quadwords: [5],
        /** @param {number[]} args */
        handler: args=>(seen.push(args.slice()), 0) });
    stack.dispatcher.dispatch(2);
    assert.deepEqual(seen[1], [1, 2, 3, 4, 5, -2, -1, 7]);

    assert.throws(()=>dispatcher.register(3, { name: 'X!Short', ...STDCALL, argBytes: 8,
        quadwords: [1], handler: ()=>0 }), /quadwords/, 'a quadword needs two dwords');
});

test('a float or a double among the first four is read from the XMM register of its slot', ()=>{
    // _jn(int n, double x): ECX, then XMM1 -- the second slot's register,
    // whatever the first holds -- read into the two dwords the 32-bit handler
    // takes it in. powf(float, float): XMM0 and XMM1, a dword each.
    const { dispatcher } = longMachine({ rcx: 3n, r11: 0x55n });
    /** @type {Map<number, number[]>} */
    const xmm = new Map([[0, [0x40490fdb, 7, 7, 7]], [1, [0x54442d18, 0x400921fb, 9, 9]]]);
    /** @type {any} */ (dispatcher).cpu.readXmm = (/** @type {number} */ index)=>
        Uint32Array.from(xmm.get(index) ?? [0, 0, 0, 0]);
    /** @type {number[][]} */
    const seen = [];
    dispatcher.register(1, { name: 'X!_jn', ...STDCALL, argBytes: 12, floats: { 1: 'f64' },
        /** @param {number[]} args */
        handler: args=>(seen.push(args.slice()), 0) });
    dispatcher.dispatch(1);
    assert.deepEqual(seen[0], [3, 0x54442d18, 0x400921fb]);

    dispatcher.register(2, { name: 'X!powf', ...STDCALL, argBytes: 8,
        floats: { 0: 'f32', 1: 'f32' },
        /** @param {number[]} args */
        handler: args=>(seen.push(args.slice()), 0) });
    dispatcher.dispatch(2);
    assert.deepEqual(seen[1], [0x40490fdb, 0x54442d18], 'one dword each, the low lane');

    // Past the four registers a float is its stack slot, as any argument is,
    // and a double the slot's two dwords; the slots after a double come one
    // earlier than the dwords say.
    const stack = longMachine({ rcx: 1n, r11: 2n, r8: 3n, r9: 4n });
    /** @type {Map<number, number>} */
    const words = new Map([[0x8000, 0x401234], [0x8028, 0x3f800000], [0x8030, 0x11],
        [0x8034, 0x40000000], [0x8038, 7]]);
    /** @type {any} */ (stack.dispatcher).memory = {
        /** @param {number} address */
        readU32: address=>words.get(address) ?? 0, writeU32: ()=>{} };
    /** @type {any} */ (stack.dispatcher).cpu.readXmm = ()=>Uint32Array.of(0, 0, 0, 0);
    stack.dispatcher.register(3, { name: 'X!Late', ...STDCALL, argBytes: 32,
        floats: { 4: 'f32', 5: 'f64' },
        /** @param {number[]} args */
        handler: args=>(seen.push(args.slice()), 0) });
    stack.dispatcher.dispatch(3);
    assert.deepEqual(seen[2], [1, 2, 3, 4, 0x3f800000, 0x11, 0x40000000, 7]);

    assert.throws(()=>dispatcher.register(4, { name: 'X!Past', ...STDCALL, argBytes: 8,
        floats: { 1: 'f64' }, handler: ()=>0 }), /f64/, 'a double needs two dwords');
    assert.throws(()=>dispatcher.register(5, { name: 'X!Both', ...STDCALL, argBytes: 8,
        quadwords: [0], floats: { 0: 'f64' }, handler: ()=>0 }), /f64/,
    'and is not a quadword besides');
});
