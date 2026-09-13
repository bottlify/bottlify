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
 */
function machine(options = {}){
    const { esp = 0x3000, args = [], profiler, callPhases = false, lastError, ecx = 0 } = options;
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
        cpu, memory, parking, profiler, callPhases, lastError,
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

    assert.deepEqual(opened, ['begin trap', 'end trap'],
        'the crossing is timed; the call is not, unless a measurement asks');
    for (let more = 1; more < 16; more++)
    {
        built.dispatcher.dispatch(1);
    }
    assert.deepEqual(opened, ['begin trap', 'end trap', 'begin trap', 'end trap'],
        'one crossing in eight is timed, standing for the eight');

    opened.length = 0;
    const timed = machine({
        profiler: {
            /** @param {string} name */
            begin: name=>opened.push(`begin ${name}`),
            /** @param {string} [name] @param {{ weight?: number }} [detail] */
            end: (name, detail)=>opened.push(
                `end ${name}${detail?.weight ? ` x${detail.weight}` : ''}`),
        },
        callPhases: true,
    });
    timed.dispatcher.register(1, {
        name: 'TEST.dll!Something', convention: 'stdcall', argBytes: 0, handler: ()=>7,
    });
    timed.dispatcher.dispatch(1);
    assert.deepEqual(opened, [
        'begin trap',
        'begin TEST.dll!Something',
        'end TEST.dll!Something',
        'end trap x8',
    ], 'asked for, the handler runs inside the crossing, which keeps only its own time');
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
