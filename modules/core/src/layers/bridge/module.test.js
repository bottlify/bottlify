/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The one rule that three separate defects have each broken: a host handler
 * that calls guest code must build the callback's frame on the stack of the
 * thread whose call it is answering, and on no other.
 *
 * These go through the assembled bridge rather than its parts, because the
 * defect is never visible in a part. Each time it has been the seam between
 * them -- a handler awaits, the dispatcher ends its call, the loop gives other
 * threads their turns, and the piece that decides where the frame goes is asked
 * a question whose answer has quietly changed underneath it. Testing the pieces
 * one at a time is what let the same bug be fixed twice and come back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeModule } from './module.js';

/** Where a held thread spins. */
const PARK = 0x00900000;

/** Two stacks far enough apart that a write to the wrong one is unmistakable. */
const MAIN = { top: 0x00300000, limit: 0x00200000 };
const WORKER = { top: 0x00700000, limit: 0x00600000 };

/**
 * As much of a machine as the bridge touches: registers, a sparse memory, a
 * trap table and two threads with stacks of their own. Nothing executes -- what
 * is under test is where the bridge decides to write, and that is decided
 * before any guest instruction runs.
 */
async function bridge(){
    /** @type {Record<string, number>} */
    const regs = { esp: 0, ecx: 0, eax: 0 };
    /** @type {Map<number, number>} */
    const cells = new Map();
    /** @type {((id: number) => void) | null} */
    let onTrap = null;
    let nextTrap = 1;

    /** @param {string} name @param {{ top: number, limit: number }} stack */
    const thread = (name, stack)=>({ name, stackTop: stack.top, stackLimit: stack.limit });
    const main = thread('main', MAIN);
    const worker = thread('thread-3', WORKER);
    /** @type {any} */
    let running = main;
    /** @type {any[]} */
    const resumed = [];

    /** @type {any} */
    const apis = {
        cpu: {
            /** @param {string} which */
            readReg32: which=>regs[which] ?? 0,
            /** @param {string} which @param {number} value */
            writeReg32: (which, value)=>{
                regs[which] = value >>> 0;
            },
            registerTrap: ()=>{
                const id = nextTrap++;
                return { id, address: 0x00900000 + id * 16 };
            },
            /** @param {any} fn */
            onTrap: fn=>{
                onTrap = fn;
            },
            parkAddress: ()=>PARK,
        },
        kernel: {
            currentThread: ()=>running,
            threads: ()=>[main, worker],
            holdThread: ()=>{},
            parkThread: ()=>{},
            /** @param {any} which @param {any} where */
            scheduleResume: (which, where)=>resumed.push({ thread: which.name, ...where }),
        },
        memory: {
            /** @param {number} at */
            readU32: at=>cells.get(at >>> 0) ?? 0,
            /** @param {number} at @param {number} value */
            writeU32: (at, value)=>cells.set(at >>> 0, value >>> 0),
            /**
             * @param {number} at @param {number} count
             * @param {number[]} into @param {number} [index]
             */
            readU32sInto: (at, count, into, index = 0)=>{
                for (let word = 0; word < count; word++)
                {
                    into[index + word] = (cells.get((at + word * 4) >>> 0) ?? 0) | 0;
                }
            },
            readBytes: ()=>new Uint8Array(0),
            /** @param {number} at @param {number} length */
            window: (at, length)=>{
                const bytes = new Uint8Array(length);
                const view = new DataView(bytes.buffer);
                for (let i = 0; i < length; i += 4)
                {
                    view.setUint32(i, (cells.get((at + i) >>> 0) ?? 0) >>> 0, true);
                }
                return bytes;
            },
        },
        log: { begin: ()=>{}, end: ()=>{} },
    };

    const api = await bridgeModule.create({}, /** @type {any} */ ({
        /** @param {string} name */
        requireApi: name=>apis[name],
    }));

    return {
        api,
        main,
        worker,
        resumed,
        regs,
        /** A word of the machine's memory. @param {number} at */
        readU32: at=>cells.get(at >>> 0) ?? 0,
        /** Runs a registered function the way a guest `call` would. */
        /** @param {number} id @param {any} on @param {number} esp */
        trap: (id, on, esp)=>{
            running = on;
            regs.esp = esp;
            cells.set(esp, 0x00401000);
            /** @type {any} */ (onTrap)(id);
        },
        /** Which trap id the last `register` took. */
        lastTrap: ()=>nextTrap - 1,
    };
}

/** Lets the microtask queue drain, which is where an awaited handler resumes. */
const settle = ()=>new Promise(done=>setTimeout(done, 0));

test('a handler holding the processor calls back onto its own thread', async()=>{
    const machine = await bridge();
    /** @type {number[]} */
    const seen = [];
    machine.api.register('TEST.dll!CallsBack', {
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([value])=>{
            seen.push(value);
            return machine.api.callGuest({ entry: 0x00402000, args: [value] });
        },
    });
    machine.trap(machine.lastTrap(), machine.main, MAIN.top - 0x100);
    await settle();

    assert.deepEqual(seen, [0]);
    const built = machine.resumed.at(-1);
    assert.equal(built.thread, 'main');
    assert.ok(built.esp < MAIN.top && built.esp > MAIN.limit,
        `the frame at 0x${built.esp.toString(16)} is on main's own stack`);
});

test('a handler that awaited is refused a callback it has not named a thread for', async()=>{
    // This is the class, stated once. Every instance of it so far has been a
    // handler that awaited a file, a range request or a mixer, resumed on a turn
    // that belonged to another thread, and called the guest back as though
    // nothing had moved. There is no answer this can give that is right: the
    // thread on the processor is a stranger, and the call in flight is the
    // stranger's. So it refuses and says so, instead of writing a frame onto
    // whichever stack is nearest.
    const machine = await bridge();
    /** @type {unknown} */
    let refused = null;
    machine.api.register('TEST.dll!AwaitsThenCallsBack', {
        argBytes: 4,
        handler: async()=>{
            await settle();
            try
            {
                return await machine.api.callGuest({ entry: 0x00402000, args: [1] });
            }
            catch (e){
                refused = e;
                return 0;
            }
        },
    });
    const id = machine.lastTrap();
    machine.trap(id, machine.main, MAIN.top - 0x100);
    // While it waits, another thread traps: that is the turn its continuation
    // lands on, and the stack it would otherwise have taken for its own.
    machine.trap(id, machine.worker, WORKER.top - 0x100);
    await settle();
    await settle();
    await settle();

    assert.match(String(refused), /must name the thread whose call it answers/);
    assert.ok(!machine.resumed.some(frame=>frame.thread === 'thread-3' && frame.eip === 0x00402000),
        'and nothing was built on the stranger\'s stack');
});

test('a handler that awaited and named its thread builds on that thread\'s stack', async()=>{
    const machine = await bridge();
    machine.api.register('TEST.dll!AnswersLater', {
        argBytes: 4,
        handler: async()=>{
            const asked = machine.main;
            await settle();
            return machine.api.callGuest({ entry: 0x00402000, args: [1], thread: asked });
        },
    });
    const id = machine.lastTrap();
    machine.trap(id, machine.main, MAIN.top - 0x100);
    machine.trap(id, machine.worker, WORKER.top - 0x100);
    await settle();
    await settle();
    await settle();

    const built = machine.resumed.filter(frame=>frame.eip === 0x00402000);
    assert.ok(built.length > 0, 'the callback was started');
    for (const frame of built)
    {
        assert.equal(frame.thread, 'main');
        assert.ok(frame.esp < MAIN.top && frame.esp > MAIN.limit,
            `0x${frame.esp.toString(16)} is on main's stack, not the worker's`);
    }
});

test('a frame that would land off its thread\'s stack is refused, whatever led there', async()=>{
    // The backstop under the rule above. Wherever a resting position comes from
    // -- a frame, a suspended call, a caller that worked one out -- a callback
    // frame belongs on the stack of the thread that will run it, and anything
    // else is a corruption that says nothing at the time. This is what makes a
    // fourth instance of the defect announce itself where it happens.
    const machine = await bridge();
    /** @type {unknown} */
    let refused = null;
    // The worker is stopped inside a call of its own, and its resting position
    // was recorded from a stack that is not the worker's -- which is exactly the
    // state every one of these defects produced.
    machine.api.register('TEST.dll!Suspends', {
        argBytes: 4,
        handler: ()=>new Promise(()=>{}),
    });
    const suspends = machine.lastTrap();
    machine.api.register('TEST.dll!Wild', {
        argBytes: 4,
        handler: ()=>{
            try
            {
                return machine.api.callGuest({
                    entry: 0x00402000, args: [], thread: machine.worker,
                });
            }
            catch (e){
                refused = e;
                return 0;
            }
        },
    });
    const wild = machine.lastTrap();
    machine.trap(suspends, machine.worker, MAIN.top - 0x200);
    machine.trap(wild, machine.main, MAIN.top - 0x100);
    await settle();

    assert.match(String(refused), /callback frame for thread-3 .* is outside its stack/);
});

test('a second instance in one realm does not take the first one\'s state', async()=>{
    const first = await bridge();
    /** @type {number[]} */
    const seen = [];
    first.api.register('TEST.dll!First', {
        argBytes: 0,
        handler: ()=>{
            seen.push(1);
            return 0;
        },
    });
    const firstTrapId = first.lastTrap();

    // A second instance, in the same realm, registering a trap of its own --
    // with the same id, since each machine's own trap table starts at one.
    const second = await bridge();
    second.api.register('TEST.dll!Second', {
        argBytes: 0,
        handler: ()=>{
            throw new Error('the second instance must never see a trap raised on the first');
        },
    });

    first.trap(firstTrapId, first.main, MAIN.top - 0x100);
    await settle();

    assert.deepEqual(seen, [1],
        'the trap on the first machine ran the first instance\'s own handler');
});

test('a disposed bridge answers harmlessly rather than throwing', async()=>{
    const machine = await bridge();
    machine.api.register('TEST.dll!Something', { argBytes: 0, handler: ()=>0 });

    await bridgeModule.dispose();

    assert.equal(machine.api.register('TEST.dll!Late', { argBytes: 0, handler: ()=>0 }), 0);
    assert.equal(
        machine.api.watch('TEST.dll!LateWatch', { argBytes: 0, target: 0x1000, handler: ()=>0 }),
        0);
    assert.equal(machine.api.park(), undefined);
    assert.equal(await machine.api.callGuest({ entry: 0x00402000 }), 0);
    assert.equal(machine.api.useHeap({ allocate: ()=>0 }), null);
    assert.equal(machine.api.publishInterface({ interfaceFor: ()=>null }, 'IUnknown'), 0);
    assert.equal(machine.api.unpublishInterface({}, 'IUnknown'), false);
    assert.equal(machine.api.suspended(), 0);
    await machine.api.answered();
    assert.equal(machine.api.callerThread(), null);
    assert.deepEqual(machine.api.recentlyStarted(), []);
    assert.deepEqual(machine.api.recorded(), []);
    assert.equal(machine.api.failure(), null);
    assert.equal(machine.api.sentinelTrap(), null);
    assert.deepEqual(machine.api.chain(), []);
    assert.deepEqual(machine.api.recent(), []);
    assert.equal(machine.api.symbolize(0x1000), null);
    machine.api.label(0x1000, 'x');
    machine.api.dispatch(1);
    assert.deepEqual(machine.api.calls(), []);
});

test('an interface is given back through the bridge that published it', async()=>{
    const machine = await bridge();
    const IID = '{00000001-0000-0000-C000-000000000046}';
    assert.equal(machine.api.unpublishInterface({}, IID), false, 'nothing is published yet');
    /** @type {number[]} */
    const freed = [];
    let next = 0x5000;
    machine.api.useHeap({
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += bytes;
            return at;
        },
        free: (/** @type {number} */ at)=>freed.push(at),
    });
    const object = {
        /** @param {string} id */
        interfaceFor: id=>({ id, methods: [{ name: 'GetDesc', argBytes: 8, invoke: ()=>0 }] }),
    };
    const pointer = machine.api.publishInterface(object, IID);
    assert.notEqual(pointer, 0);
    assert.equal(machine.api.unpublishInterface(object, IID), true);
    assert.deepEqual(freed, [pointer]);
    assert.equal(machine.api.unpublishInterface(object, IID), false);
    await bridgeModule.dispose();
});

test('register refuses FASTCALL -- only hook builds a stub that saves EDX', async()=>{
    const machine = await bridge();
    assert.throws(
        ()=>machine.api.register('TEST.dll!Fast', {
            convention: machine.api.Convention.FASTCALL, argBytes: 8, handler: ()=>0,
        }),
        /FASTCALL/);
});

test('diagnostics answers for the live instance', async()=>{
    await bridge();
    const second = await bridge();
    second.api.register('TEST.dll!B', { argBytes: 0, handler: ()=>0 });
    second.api.register('TEST.dll!C', { argBytes: 0, handler: ()=>0 });

    const diag = /** @type {any} */ (bridgeModule.diagnostics());
    assert.equal(diag.status, 'ready');
    assert.equal(diag.metrics.implemented, 2,
        'diagnostics reports the second (most recent) instance');

    await bridgeModule.dispose();
});

test('a handler that answers with a continuation sends the thread there, not back', async()=>{
    // An exception handler that found its block: the call it is answering, and
    // the throw that led to it, never return.
    const machine = await bridge();
    machine.api.register('TEST.dll!Catches', {
        argBytes: 4,
        handler: ()=>Promise.resolve(machine.api.continueAt(
            { eip: 0x00402200, esp: 0x002ff500, ebp: 0x002ff5a0 })),
    });
    machine.trap(machine.lastTrap(), machine.main, 0x002ff000);
    await settle();

    assert.deepEqual(machine.resumed.at(-1), {
        thread: 'main', eip: 0x00402200, esp: 0x002ff500, registers: { ebp: 0x002ff5a0 },
    });
    assert.equal(machine.api.suspended(), 0, 'and the call it abandoned is no longer waiting');
});

test('a continuation must say where the stack is as well as where to go', async()=>{
    const machine = await bridge();
    assert.throws(()=>machine.api.continueAt({ eip: 0x401000 }), /eip and esp/);
});

test('a thread holding for its fault waits in the park loop and goes where it is told', async()=>{
    const machine = await bridge();
    /** @type {(value: any) => void} */
    let answer = ()=>{};
    machine.api.holdForFault(machine.main,
        { name: '<divide error>', restingStack: 0x002ff000, hostReturn: 0x00401000 },
        new Promise(resolve=>{
            answer = resolve;
        }));

    assert.equal(machine.regs.eip, PARK, 'the stub\'s halt is never reached');
    assert.equal(machine.api.suspended(), 1, 'the thread is waiting, as for a host call');

    answer(machine.api.continueAt({ eip: 0x00401800, esp: 0x002ff100 }));
    await settle();

    assert.deepEqual(machine.resumed.at(-1),
        { thread: 'main', eip: 0x00401800, esp: 0x002ff100 });
    assert.equal(machine.api.suspended(), 0);
});

/**
 * Two guest calls, the second given what the first answered; the sum answered.
 *
 * @returns {import('./internal/drive.js').Steps}
 */
function* twoCalls(){
    const first = yield { entry: 0x00402000, args: [5] };
    const second = yield { entry: 0x00402100, args: [first, 2] };
    return first + second;
}

test('steps a handler answers with enter each guest call in the slice the call came in, and'
    + ' answer it there', async()=>{
    const machine = await bridge();
    machine.api.register('TEST.dll!Steps', {
        argBytes: 4,
        handler: ()=>machine.api.drive(twoCalls()),
    });
    const esp = MAIN.top - 0x100;
    machine.trap(machine.lastTrap(), machine.main, esp);
    // Into the first routine at once: its frame below where the call left the
    // stack, the sentinel as its return address, and nothing to resume later.
    assert.equal(machine.regs.eip, 0x00402000);
    assert.equal(machine.regs.esp, esp - 4 * 3);
    assert.deepEqual(machine.resumed, []);

    const sentinel = /** @type {number} */ (machine.api.sentinelTrap());
    // The routine's `ret 4`, its answer moved to ECX by the sentinel's stub.
    machine.regs.esp = esp - 4 * 3 + 8;
    machine.regs.ecx = 7;
    machine.trap(sentinel, machine.main, machine.regs.esp);
    assert.equal(machine.regs.eip, 0x00402100, 'the next routine, in the same slice');
    assert.deepEqual(machine.resumed, []);

    machine.regs.esp += 12;
    machine.regs.ecx = 9;
    machine.trap(sentinel, machine.main, machine.regs.esp);
    // Back where the call returns, past its argument, with the answer.
    assert.equal(machine.regs.eax, 16);
    assert.equal(machine.regs.eip, 0x00401000);
    assert.equal(machine.regs.esp, esp + 4 + 4);
    assert.deepEqual(machine.resumed, []);
});

test('steps that call the guest for nothing answer as a plain handler does', async()=>{
    const machine = await bridge();
    machine.api.register('TEST.dll!NoSteps', {
        argBytes: 0,
        // eslint-disable-next-line require-yield
        handler: ()=>machine.api.drive((function*(){
            return 42;
        })()),
    });
    machine.trap(machine.lastTrap(), machine.main, MAIN.top - 0x100);
    assert.equal(machine.regs.eax, 42);
    assert.deepEqual(machine.resumed, []);
});

/**
 * An object with a method answered in place and one that is not, published
 * on a machine with a heap; the slots of each and what the first was called with.
 */
async function inPlaceObject(){
    const machine = await bridge();
    let next = 0x5000;
    machine.api.useHeap({ allocate: (/** @type {number} */ bytes)=>{
        const at = next;
        next += bytes;
        return at;
    } });
    /** @type {number[][]} */
    const made = [];
    const methods = [
        { name: 'SetValue', argBytes: 8, invoke: ()=>0,
            inPlace: (/** @type {number[]} */ [, value])=>{
                made.push([value]);
                return value * 10;
            } },
        { name: 'Other', argBytes: 8, invoke: ()=>0 },
    ];
    const object = { interfaceFor: (/** @type {string} */ id)=>({ id, methods }) };
    const pointer = machine.api.publishInterface(object, '{00000002-0000-0000-C000-000000000046}');
    return { machine, pointer, made };
}

test('steps whose calls go to a method answered in place answer without entering the guest',
    async()=>{
        // A device's setter called from an effect's CommitChanges: what the guest
        // would only have written into the ring is made by its handler here.
        const { machine, pointer, made } = await inPlaceObject();
        const table = machine.readU32(pointer);
        const setValue = machine.readU32(table);
        machine.api.register('TEST.dll!Commit', {
            argBytes: 0,
            handler: ()=>machine.api.drive((/** @returns {import('./internal/drive.js').Steps} */ function*(){
                const a = yield { entry: setValue, args: [pointer, 3] };
                const b = yield { entry: setValue, args: [pointer, 4] };
                return a + b;
            })()),
        });
        machine.trap(machine.lastTrap(), machine.main, MAIN.top - 0x100);
        assert.equal(machine.regs.eax, 70, 'each call answered, and the steps with them');
        assert.deepEqual(made, [[3], [4]]);
        // Answered as a plain handler is, by the stub's own return: nothing
        // entered, nothing parked.
        assert.deepEqual(machine.resumed, []);
        assert.equal(machine.api.suspended(), 0);
        assert.equal(/** @type {any} */ (bridgeModule.diagnostics()).metrics.driveInPlace, 2);
    });

test('steps mixing calls answered in place with calls into the guest enter the guest for those'
    + ' alone, in order', async()=>{
    const { machine, pointer, made } = await inPlaceObject();
    const table = machine.readU32(pointer);
    const setValue = machine.readU32(table);
    machine.api.register('TEST.dll!Mixed', {
        argBytes: 0,
        handler: ()=>machine.api.drive((/** @returns {import('./internal/drive.js').Steps} */ function*(){
            const a = yield { entry: setValue, args: [pointer, 1] };
            const b = yield { entry: 0x00402000, args: [a] };
            const c = yield { entry: setValue, args: [pointer, b] };
            return c;
        })()),
    });
    const esp = MAIN.top - 0x100;
    machine.trap(machine.lastTrap(), machine.main, esp);
    assert.equal(machine.regs.eip, 0x00402000, 'the guest routine, entered after the first call');
    assert.deepEqual(made, [[1]]);
    machine.regs.esp = esp - 4 * 2 + 4;
    machine.regs.ecx = 5;
    machine.trap(/** @type {number} */ (machine.api.sentinelTrap()), machine.main, machine.regs.esp);
    assert.deepEqual(made, [[1], [5]], 'the third made in place with what the guest answered');
    assert.equal(machine.regs.eax, 50);
    assert.equal(machine.regs.eip, 0x00401000);
});
