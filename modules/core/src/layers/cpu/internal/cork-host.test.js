/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cork host without an emulator: its own memory and layout, the state
 * block captured and restored whole, the eager flags word, and the cpu api's
 * context over it. A small program runs here too, for the interpreter tier's
 * instruction count; the wider interpreter tier is `cork-host.itest.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORK_TSC_MHZ, createCorkHost } from './cork-host.js';
import { freshThreadFpu } from './context.js';
import * as engine from '../../../../../cork/src/index.js';

const MEMORY = 4 << 20;
const ENGINE_URL = new URL('../../../../../cork/src/index.js', import.meta.url).href;

/** @param {Record<string, unknown>} [config] */
function host(config = {}){
    return createCorkHost({
        engine,
        memorySize: MEMORY,
        trapPort: 0x1234,
        entryVector: 0x7000,
        initialStack: 0x300000,
        cork: {},
        ...config,
    });
}

test('the eager flags word is what readReg32("eflags") answers', ()=>{
    const h = host();
    h.writeReg32('eflags', 0x246);
    assert.equal(h.readReg32('eflags'), 0x246);
    h.writeReg32('eflags', 0x2);
    assert.equal(h.readReg32('eflags'), 0x2);
});

test('the registers live in the block and read back', ()=>{
    const h = host();
    h.writeReg32('eax', 0xdeadbeef);
    h.writeReg32('esp', 0x80000);
    assert.equal(h.readReg32('eax') >>> 0, 0xdeadbeef);
    assert.equal(h.readReg32('esp') >>> 0, 0x80000);
    assert.throws(()=>h.readReg32('nope'), /Unknown register/);
});

test('the register file lent to the bridge is the registers themselves, in encoding order', ()=>{
    const h = host();
    const file = h.registerFile();
    h.writeReg32('esp', 0x80000);
    h.writeReg32('ecx', 0x1234);
    assert.equal(file[4], 0x80000, 'ESP as written by name');
    assert.equal(file[1], 0x1234, 'ECX');
    file[0] = -2;
    assert.equal(h.readReg32('eax') >>> 0, 0xfffffffe, 'and EAX written in place reads back');
    assert.equal(h.registerFile(), file, 'one view for the life of the machine');
});

test('a span of dwords reads signed into an array at an offset, as the words read one by one', ()=>{
    const h = host();
    h.writePhysical(0x2000, new Uint8Array([1, 0, 0, 0, 0xfe, 0xff, 0xff, 0xff, 0, 0, 0, 0x80]));
    /** @type {number[]} */
    const into = [9, 0, 0, 0];
    h.readU32sInto(0x2000, 3, into, 1);
    assert.deepEqual(into, [9, 1, -2, -0x80000000]);
    assert.deepEqual(into.slice(1), [0x2000, 0x2004, 0x2008].map(at=>h.readU32(at) | 0));
});

test('a captured context round-trips every block field', ()=>{
    const h = host();
    const layout = h.blockLayout();
    const block = h.block();
    for (let at = 0; at < block.length; at++)
    {
        block[at] = (at * 31 + 7) & 0xff;
    }
    const context = h.captureContext();
    block.fill(0);
    h.restoreContext(context);
    const restored = h.block();
    for (let at = 0; at < restored.length; at++)
    {
        // The retired-instruction counter is the machine's, not the thread's:
        // a restore leaves the live word where it is.
        if (at >= layout.counter && at < layout.counter + 4)
        {
            continue;
        }
        assert.equal(restored[at], (at * 31 + 7) & 0xff, `byte ${at}`);
    }
});

test('a restore leaves the live instruction counter where it is', ()=>{
    const h = host();
    const layout = h.blockLayout();
    const block = h.block();
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    view.setUint32(layout.counter, 1234, true);
    const context = h.captureContext();
    view.setUint32(layout.counter, 5678, true);
    h.restoreContext(context);
    assert.equal(view.getUint32(layout.counter, true), 5678);
});

test('a context positions eip and esp', ()=>{
    const h = host();
    h.writeReg32('eip', 0x401000);
    h.writeReg32('esp', 0x80000);
    const context = h.captureContext();
    h.writeReg32('eip', 0);
    h.writeReg32('esp', 0);
    h.restoreContext(context);
    assert.equal(h.readReg32('eip'), 0x401000);
    assert.equal(h.readReg32('esp'), 0x80000);
});

/**
 * Writes a program and points the entry vector at it.
 *
 * @param {ReturnType<typeof host>} h @param {number} at @param {number[]} bytes
 */
function load(h, at, bytes){
    h.writePhysical(at, Uint8Array.from(bytes));
    const vector = new Uint8Array(4);
    new DataView(vector.buffer).setUint32(0, at, true);
    h.writePhysical(0x7000, vector);
}

test('the interpreter\'s retired instructions read back through instructionCount', ()=>{
    const h = host();
    // mov eax, 0; inc eax; inc eax; inc eax; hlt -- five instructions.
    load(h, 0x1000, [0xb8, 0, 0, 0, 0, 0x40, 0x40, 0x40, 0xf4]);
    assert.equal(h.runSlice(100), 5);
    assert.equal(h.instructionCount(), 5);

    // A count that only ever grew: the same host runs a loop and the total is
    // everything retired, not the last slice's worth.
    const loop = host();
    // mov ecx, 2000; dec ecx; jnz -3; hlt -- 1 + 2000*2 + 1 = 4002.
    load(loop, 0x2000, [0xb9, 0xd0, 0x07, 0, 0, 0x49, 0x75, 0xfd, 0xf4]);
    // To its halt, however many slices: an interpreted slice also ends on time.
    for (let slices = 0; !loop.halted() && slices < 1000; slices++)
    {
        loop.runSlice(1 << 16);
    }
    assert.equal(loop.instructionCount(), 4002);
});

test('a slice that interprets ends once it has taken its time, and the next goes on from there',
    ()=>{
        // Nothing translated: mov ecx, 1500000; dec ecx; jnz -3; hlt -- three million
        // instructions, interpreted, under one slice's budget of all of them.
        const h = host({ cork: { translate: false } });
        load(h, 0x2000, [0xb9, 0x60, 0xe3, 0x16, 0, 0x49, 0x75, 0xfd, 0xf4]);
        const total = 1 + 1_500_000 * 2 + 1;
        const first = h.runSlice(total);
        assert.ok(first < total, `the first slice ended early (${first})`);
        let slices = 1;
        while (!h.halted() && slices < 100_000)
        {
            h.runSlice(total);
            slices++;
        }
        assert.equal(h.halted(), true);
        assert.equal(h.instructionCount(), total, 'every instruction once, across the slices');
    });

test('an instruction no tier carries is an invalid-opcode fault, and the slice counts what ran',
    ()=>{
        // A fault the program's own handlers can take, as a processor raises
        // for an instruction it does not know, rather than the engine stopping.
        const h = host();
        // Four nops, then sldt [eax]: the model has no case for it.
        load(h, 0x1000, [0x90, 0x90, 0x90, 0x90, 0x0f, 0x00, 0x00, 0xf4]);
        h.runSlice(100);
        assert.equal(h.instructionCount(), 4, 'the four nops it ran, not the one it stopped on');
        const fault = h.fault();
        assert.equal(fault?.vector, 6, '#UD');
        assert.equal(fault?.eip, 0x1004, 'at the instruction');
        assert.deepEqual(h.corkDiagnostics().untiered?.length, 1, 'and named in the diagnostics');
    });

test('a call through a null pointer faults where nothing runs, and the range still reads', ()=>{
    // The first 64 KiB stay open to reads, which a title leans on, but a
    // call into them slid through zeroes into the entry vector and ran it.
    // The JavaScript tier: the wasm tier does not fence its fetches yet, and
    // once a process has started it, every host's interpreted code runs there.
    const h = host({ noExecuteBelow: 0x10000, cork: { wasmInterpreter: false } });
    // mov eax, [0x100]; xor ecx, ecx; call ecx -- at 0x20000.
    load(h, 0x20000, [0xa1, 0x00, 0x01, 0x00, 0x00, 0x31, 0xc9, 0xff, 0xd1, 0xf4]);
    h.writePhysical(0x100, Uint8Array.of(0x78, 0x56, 0x34, 0x12));
    h.runSlice(100);
    assert.equal(h.readReg32('eax'), 0x12345678, 'the read below went through');
    const fault = h.fault();
    assert.equal(fault?.vector, 14, 'a page fault');
    assert.equal(fault?.eip, 0, 'at the address the call went to');
});

test('a call into code left untranslated runs on the wasm tier in place, not through the host',
    async()=>{
        const CALLS = 3000;
        /** @param {number} value */
        const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24];
        /** @param {boolean} wasmInterpreter */
        const run = async wasmInterpreter=>{
            const h = host({
                cork: { wasmInterpreter, wasmInterpreterAfter: 0, leafCalls: false },
            });
            // mov al, 0xc3; mov ecx, CALLS; L: call F; dec ecx; jnz L; hlt -- where F is
            // mov [F + 5], al; ret: a routine that writes its own page, which is left to
            // the interpreter once its regions have been dropped often enough.
            load(h, 0x1000, [0xb0, 0xc3, 0xb9, ...u32(CALLS), 0xe8, ...u32(0x4000 - 0x100c),
                0x49, 0x75, 0xf8, 0xf4]);
            h.writePhysical(0x4000, Uint8Array.from([0xa2, ...u32(0x4005), 0xc3]));
            while (!h.halted())
            {
                h.runSlice(100_000);
                await h.cork().translatePending();
            }
            return { ecx: h.readReg32('ecx'), count: h.instructionCount(),
                exits: h.corkDiagnostics().exits };
        };
        const js = await run(false);
        const tier = await run(true);
        assert.deepEqual([tier.ecx, tier.count], [js.ecx, js.count], 'the same run');
        assert.ok(js.exits.untranslated > CALLS * 0.8, `${js.exits.untranslated} calls left`);
        assert.ok(tier.exits.untranslated + tier.exits.interpreted < CALLS * 0.1,
            `${tier.exits.untranslated} + ${tier.exits.interpreted} calls left`);
    });

test('the status words the wasm tier stores unless precise are counted in the diagnostics', ()=>{
    for (const precise of [false, true])
    {
        // The tier from the first instruction, not after the JavaScript interpreter's stretch.
        const h = host({ cork: { translate: false, precise, wasmInterpreterAfter: 0 } });
        // fld1; fnstsw ax; hlt
        load(h, 0x1000, [0xd9, 0xe8, 0xdf, 0xe0, 0xf4]);
        assert.equal(h.runSlice(100), 3);
        assert.equal(h.corkDiagnostics().interpretedRelaxedReads, precise ? 0 : 1);
    }
});

test('the host boots a real runtime over cork\'s own memory', ()=>{
    const h = host();
    assert.equal(h.engine(), 'cork');
    assert.ok(h.cork(), 'the translator runtime is built');
    assert.equal(h.readReg32('eflags'), 0x2, 'the boot eflags word');
    assert.equal(h.controlRegister(0), 1, 'PE is set: flat 32-bit protected mode');
    assert.equal(h.controlRegister(3), 0, 'and no CR3');
    assert.equal(h.inProtectedMode(), true);
});

test('the interpreter stops only at an entry for the top the machine has', async()=>{
    const h = host();
    // fld1; hlt -- translated at top 0 alone.
    load(h, 0x1000, [0xd9, 0xe8, 0xf4]);
    h.cork().noteHot(0x1000, 0);
    assert.ok(await h.cork().translatePending() >= 1, 'the top 0 region formed');
    assert.ok(h.cork().entryOf(0x1000, 0) >= 0);
    assert.equal(h.cork().entryOf(0x1000, 1), -1, 'no region for top 1');
    // The machine stands at the same address with top 1: the entry compiled
    // for top 0 is no answer, so the interpreter runs the code and leaves the
    // top its own fld1 wrote (0), not the region's static (7).
    h.block()[h.blockLayout().x87Top] = 1;
    h.writeReg32('eip', 0x1000);
    assert.equal(h.runSlice(100), 2, 'the interpreter ran fld1 and hlt');
    assert.equal(h.block()[h.blockLayout().x87Top], 0, 'the machine top, not the region top');
});

test('only a jump target is a hot start, not where a slice stopped', ()=>{
    const h = host({ cork: { translate: false } });
    // mov ecx, 3; nop; nop; L: dec ecx; jnz L; hlt
    load(h, 0x1000, [0xb9, 3, 0, 0, 0, 0x90, 0x90, 0x49, 0x75, 0xfd, 0xf4]);
    const runtime = h.cork();
    /** @type {number[]} */
    const noted = [];
    runtime.noteHot = (/** @type {number} */ address)=>{
        noted.push(address);
    };
    // Twice through the straight line one instruction a slice, every slice
    // starting where the last one stopped, then the loop to its end.
    for (let pass = 0; pass < 2; pass++)
    {
        h.writeReg32('eip', 0x1000);
        for (let i = 0; i < 3; i++)
        {
            h.runSlice(1);
        }
    }
    h.runSlice(100);
    assert.deepEqual(noted, [0x1007], 'the loop head its jnz reached twice, and nothing else');
});

test('eflags read through the host folds the record a region left, a write replaces it',
    async()=>{
        const h = host();
        // cmp eax, ebx; hlt -- translated, so the region leaves its record.
        load(h, 0x1000, [0x39, 0xd8, 0xf4]);
        h.cork().noteHot(0x1000, 0);
        assert.ok(await h.cork().translatePending() >= 1);
        h.writeReg32('eax', 1);
        h.writeReg32('ebx', 2);
        h.writeReg32('eip', 0x1000);
        h.runSlice(100);
        assert.equal(h.readReg32('eflags') & 0x81, 0x81, 'CF and SF of 1 - 2');
        h.writeReg32('eflags', 0x202);
        assert.equal(h.readReg32('eflags'), 0x202, 'the written word, no record over it');
    });

test('a hlt ends the slice and the next slice goes on after it, as the timer interrupt does',
    ()=>{
        const h = host();
        // hlt; jmp -3 -- the idle loop a scheduler parks the processor in.
        load(h, 0x1000, [0xf4, 0xeb, 0xfd]);
        h.writeReg32('eip', 0x1000);
        assert.equal(h.runSlice(100), 1, 'the hlt retired and ended the slice');
        assert.equal(h.halted(), true);
        assert.equal(h.readReg32('eip'), 0x1001, 'eip past the hlt');
        assert.equal(h.runSlice(100), 2, 'the next slice runs the jump and halts again');
        assert.equal(h.halted(), true);
        assert.equal(h.runSlice(100), 2);
    });

test('a loop whose stores reach translated code goes on to its end', async()=>{
    const h = host();
    // A region on the data page: its code makes the page's stores notes.
    h.writePhysical(0x3100, Uint8Array.from([0xc3]));
    h.cork().noteHot(0x3100, 0);
    // mov esi, 0x3000; mov ecx, 64; L: mov eax, [esi]; mov [esi+4], eax;
    // add esi, 8; dec ecx; jnz L; hlt -- the loop's two accesses are one
    // group, whose window meets the code at 0x3100.
    load(h, 0x1000, [0xbe, 0x00, 0x30, 0, 0, 0xb9, 64, 0, 0, 0,
        0x8b, 0x06, 0x89, 0x46, 0x04, 0x83, 0xc6, 0x08, 0x49, 0x75, 0xf5, 0xf4]);
    h.cork().noteHot(0x1000, 0);
    assert.ok(await h.cork().translatePending() >= 2);
    h.writeReg32('eip', 0x1000);
    // The group's check leaves for the host, which interprets the access;
    // an exit the epilogue probed straight back into the same entry spun
    // there for ever with the budget untouched.
    for (let slice = 0; slice < 100 && !h.halted(); slice++)
    {
        h.runSlice(10_000);
    }
    assert.equal(h.halted(), true, 'the loop ran to its hlt');
    assert.equal(h.readReg32('ecx'), 0);
    assert.equal(h.readReg32('esi'), 0x3200);
});

test('a trap a region leaves for with x87 held in its locals runs the handler', async()=>{
    const h = host();
    // fld1; mov dx, 0x1234; mov eax, 0x55; out dx, eax; int3 -- a hook stub that
    // holds EIP, reached with the x87 stack live: the handler moves EIP on.
    load(h, 0x1000, [0xd9, 0xe8, 0x66, 0xba, 0x34, 0x12, 0xb8, 0x55, 0, 0, 0, 0xef, 0xcc]);
    h.writePhysical(0x1100, Uint8Array.from([0xf4]));
    /** @type {number[]} */
    const seen = [];
    h.onTrap((/** @type {number} */ value)=>{
        seen.push(value);
        h.writeReg32('eip', 0x1100);
    });
    h.cork().noteHot(0x1000, 0);
    assert.ok(await h.cork().translatePending() >= 1);
    h.writeReg32('eip', 0x1000);
    h.runSlice(100);
    assert.deepEqual(seen, [0x55]);
    assert.equal(h.readReg32('eip'), 0x1101, 'where the handler put EIP, then its hlt');
});

test('a context carries the flags, the x87 block and fsBase field for field', ()=>{
    const h = host();
    const layout = h.blockLayout();
    const block = h.block();
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    view.setUint32(layout.eflags, 0x246, true);
    view.setUint32(layout.fsBase, 0x7ffde000, true);
    view.setFloat64(layout.x87, 1.5, true);
    view.setUint8(layout.x87Top, 7);
    view.setUint16(layout.x87Status, 0x3840, true);
    const context = h.captureContext();
    assert.equal(context.fsBase, 0x7ffde000);
    block.fill(0);
    h.restoreContext(context);
    assert.equal(view.getUint32(layout.eflags, true), 0x246);
    assert.equal(view.getUint32(layout.fsBase, true), 0x7ffde000);
    assert.equal(view.getFloat64(layout.x87, true), 1.5);
    assert.equal(view.getUint8(layout.x87Top), 7);
    assert.equal(view.getUint16(layout.x87Status, true), 0x3840);
});

test('a host write into a translated page invalidates the region', async()=>{
    const h = host();
    const runtime = h.cork();
    h.writePhysical(0x1000, Uint8Array.from([0xb8, 1, 0, 0, 0, 0xf4]));
    runtime.noteHot(0x1000);
    assert.equal(await runtime.translatePending(), 1, 'the region was formed');
    assert.equal(runtime.holdsPage(0x1000 >>> 12), true);
    h.writePhysical(0x1000, Uint8Array.from([0x90]));
    assert.equal(runtime.holdsPage(0x1000 >>> 12), false, 'the host write dropped it');
});

test('code the host rewrites between two calls of it runs as written; a host write beside it'
    + ' leaves it translated', async()=>{
    const h = host();
    const runtime = h.cork();
    // call F; mov ebx, eax; mov dx, 0x1234; out dx, eax; call F; hlt -- F (0x1100): mov eax,
    // 1; ret, translated before the program starts; the trap's handler rewrites F's immediate.
    load(h, 0x1000, [0xe8, 0xfb, 0x00, 0, 0, 0x89, 0xc3, 0x66, 0xba, 0x34, 0x12, 0xef,
        0xe8, 0xef, 0x00, 0, 0, 0xf4]);
    h.writePhysical(0x1100, Uint8Array.from([0xb8, 1, 0, 0, 0, 0xc3]));
    runtime.noteHot(0x1100);
    assert.equal(await runtime.translatePending(), 1);
    /** @type {boolean[]} */
    const held = [];
    h.onTrap(()=>{
        // An answer into the stack's page, where nothing of the translator's is.
        h.writeData(0x2fff00, Uint8Array.from([1, 2, 3, 4]));
        h.fillData(0x2fff04, 0, 8);
        held.push(runtime.entryOf(0x1100) >= 0);
        h.writeData(0x1101, Uint8Array.from([7]));
        held.push(runtime.entryOf(0x1100) >= 0);
    });
    for (let slice = 0; slice < 10 && !h.halted(); slice++)
    {
        h.runSlice(1000);
    }
    assert.equal(h.halted(), true);
    assert.deepEqual(held, [true, false],
        'kept past the write beside it, dropped by the one into it');
    assert.equal(h.readReg32('ebx'), 1, 'the first call ran the code as translated');
    assert.equal(h.readReg32('eax'), 7, 'the second ran the code the host wrote');
});

test('newContext under cork positions eip and esp', async()=>{
    const { cpuModule } = await import('../module.js');
    const api = await cpuModule.create({
        engine: 'cork', engineUrl: ENGINE_URL, memorySize: MEMORY,
    }, /** @type {any} */ ({ requireApi: ()=>({}), provide: ()=>{} }));
    try
    {
        await api.boot();
        const context = api.newContext({ entry: 0x401000, stackTop: 0x80000 });
        api.restoreContext(context, 0);
        assert.equal(api.readReg32('eip'), 0x401000);
        assert.equal(api.readReg32('esp'), 0x80000);
        assert.equal(api.readReg32('eflags'), 0x2);
    }
    finally
    {
        await cpuModule.dispose();
    }
});

test('a tight loop run with no frame to feed the translator is translated in its stretch', ()=>{
    const h = host();
    // mov ecx, 400000; L: add eax, ecx; xor ebx, eax; dec ecx; jnz L; hlt -- every
    // note of the loop's head falls in its first 2048 interpreted instructions,
    // and only slices of the scheduler's quantum run it, as a loader's do.
    load(h, 0x1000, [0xb9, 0x80, 0x1a, 0x06, 0x00, 0x01, 0xc8, 0x31, 0xc3, 0x49, 0x75, 0xf9, 0xf4]);
    let retired = h.runSlice(100_000);
    while (!h.halted())
    {
        retired += h.runSlice(100_000);
    }
    assert.equal(retired, 1 + 400_000 * 4 + 1);
    assert.ok(h.cork().counters().translatedShare > 0.99,
        `translated share ${h.cork().counters().translatedShare}`);
});

/**
 * The engine with what each interpreter retires counted, its wasm tier's
 * process-wide stretch and start standing for a process of its own: a fresh
 * one, whatever tests ran in this one before.
 */
function countingEngine(){
    const retired = { js: 0, wasm: 0 };
    const stretch = { work: 0 };
    let started = false;
    const counting = {
        ...engine,
        /** @param {any} state @param {number} budget @param {any} hooks */
        interpret(state, budget, hooks){
            const before = state.retired;
            try
            {
                return engine.interpret(state, budget, hooks);
            }
            finally
            {
                retired.js += state.retired - before;
            }
        },
        /** @param {any} options */
        createWasmInterpreter(options){
            const tier = engine.createWasmInterpreter(options);
            return tier && { ...tier, stretch, started: ()=>started,
                run(/** @type {number} */ budget){
                    started = true;
                    const code = tier.run(budget);
                    retired.wasm += tier.retired();
                    return code;
                } };
        },
    };
    return { counting, retired };
}

/** mov ecx, n; L: dec ecx; jnz L; hlt -- 2n + 2 instructions, one jump target. */
const countdown = (/** @type {number} */ n)=>[0xb9, n & 0xff, n >>> 8 & 0xff, n >>> 16, 0,
    0x49, 0x75, 0xfd, 0xf4];

/**
 * Runs a program to its halt on a fresh host of a counting engine, and
 * answers what each interpreter retired for it.
 *
 * @param {ReturnType<typeof countingEngine>} counted @param {number[]} code
 * @param {Record<string, unknown>} [cork]
 */
function runCounted(counted, code, cork = {}){
    const before = { ...counted.retired };
    const h = host({ engine: counted.counting, cork: { translate: false, ...cork } });
    load(h, 0x1000, code);
    // To its halt, however many slices: an interpreted slice also ends on time.
    for (let slices = 0; !h.halted() && slices < 1000; slices++)
    {
        h.runSlice(100_000);
    }
    assert.ok(h.halted());
    return { js: counted.retired.js - before.js, wasm: counted.retired.wasm - before.wasm };
}

test('the JavaScript interpreter carries a process\'s first stretch, the wasm tier the rest', ()=>{
    assert.deepEqual(runCounted(countingEngine(), countdown(2000)), { js: 4002, wasm: 0 },
        'a program this short never starts the tier');
    const long = runCounted(countingEngine(), countdown(10_000));
    assert.equal(long.js + long.wasm, 20_002);
    assert.ok(long.js > 8000 && long.js <= 8192, `the stretch, then the tier: ${long.js}`);
    // 200 short jumps, each to the next four bytes on: every one a target new to the
    // interpreter, each in a count slot of its own.
    const chain = runCounted(countingEngine(),
        [...Array.from({ length: 200 }, ()=>[0xeb, 0x02, 0x90, 0x90]).flat(), 0xf4]);
    assert.equal(chain.js + chain.wasm, 201);
    assert.equal(chain.js, 65, 'new code hands over at its 64th new target, after the run there');
    assert.deepEqual(runCounted(countingEngine(), countdown(2000), { wasmInterpreterAfter: 0 }),
        { js: 0, wasm: 4002 }, 'no stretch');
});

test('the stretch is the process\'s: hosts add to it, a host after the tier started runs it',
    ()=>{
        const process = countingEngine();
        assert.deepEqual(runCounted(process, countdown(2000)), { js: 4002, wasm: 0 });
        const second = runCounted(process, countdown(2000));
        assert.equal(second.js + second.wasm, 4002);
        assert.ok(second.js < 4002 && second.js > 3900,
            `the second host spends what the first left of the stretch: ${second.js}`);
        assert.deepEqual(runCounted(process, countdown(2000)), { js: 0, wasm: 4002 },
            'the tier started, a third host runs it from its first instruction');
    });

test('a slow slice accounts for itself only when the translator\'s timings are asked for', ()=>{
    // mov dx, 0x1234; out dx, eax; hlt -- the port's handler holds the slice past
    // its 20 ms floor, as a host call the program waits on does.
    for (const timings of [false, true])
    {
        const h = host({ cork: { translate: false, timings } });
        h.onTrap(()=>{
            const until = performance.now() + 25;
            while (performance.now() < until)
            {
                // the host call's own time
            }
        });
        load(h, 0x1000, [0x66, 0xba, 0x34, 0x12, 0xef, 0xf4]);
        // The slice ends past the handler, its time spent, before the hlt.
        assert.equal(h.runSlice(100), 2);
        const stalls = /** @type {any} */ (h.cork().diagnostics()).stalls;
        assert.deepEqual(stalls.map((/** @type {{ what: string }} */ one)=>one.what.split(' ')[0]),
            timings ? ['slice'] : [], `timings ${timings}`);
    }
});

test('a fresh thread\'s block starts at 0x27f and MXCSR 0x1f80, not its creator\'s modes', ()=>{
    const h = host();
    h.restoreX87State({ top: 5, empty: 0x1f, control: 0x007f, status: 0x21,
        raw: new Uint8Array(128).fill(0x40) });
    h.writeMxcsr(0x9fc0); // flush to zero and denormals are zero
    h.writeReg32('ebx', 0x1234);
    const context = h.captureContext();
    freshThreadFpu(context);
    h.restoreContext(context);
    const x87 = h.x87State();
    assert.equal(x87.control, 0x27f);
    assert.equal(x87.top, 0);
    assert.equal(x87.empty, 0xff);
    assert.equal(x87.status, 0);
    assert.equal(h.readMxcsr(), 0x1f80);
    assert.equal(h.readReg32('ebx'), 0x1234, 'the rest of the template stays');
});

test('rdtsc counts the guest\'s clock once one is given, at CORK_TSC_MHZ, never backward', ()=>{
    const h = host();
    const perMs = BigInt(CORK_TSC_MHZ) * 1000n;
    let ms = 5000;
    h.useGuestClock(()=>ms);
    /** @returns {bigint} edx:eax after rdtsc; hlt */
    const read = ()=>{
        load(h, 0x1000, [0x0f, 0x31, 0xf4]);
        h.writeReg32('eip', 0x1000);
        h.wake?.();
        h.runSlice(10);
        return BigInt(h.readReg32('edx') >>> 0) << 32n | BigInt(h.readReg32('eax') >>> 0);
    };
    const first = read();
    assert.ok(first >= 5000n * perMs && first < 5016n * perMs + 1n,
        `the guest's 5 s in ticks, within a credit: ${first}`);
    ms = 5100;
    const second = read();
    assert.ok(second - first >= 99n * perMs && second - first < 116n * perMs + 1n,
        `a tenth of a second of guest time reads as a tenth of the rate: ${second - first}`);
    const third = read();
    assert.ok(third > second, 'the guest clock standing still, the counter still moves on');
});

test('the RAM lent to the memory layer is the machine\'s own, byte 0 at address 0', ()=>{
    const h = host();
    const ram = h.ramView();
    h.writePhysical(0x2000, new Uint8Array([0x78, 0x56, 0x34, 0x12]));
    assert.equal(new DataView(ram.buffer, ram.byteOffset).getUint32(0x2000, true), 0x12345678);
    ram[0x3000] = 0xab;
    assert.equal(h.readU32(0x3000) & 0xff, 0xab, 'and a byte written in place reads back');
    assert.equal(h.ramView(), ram, 'one view for the life of the machine');
});

test('addresses below closedBelow fault on a fetch and a store; none are closed by default',
    ()=>{
        // call [0x20100], whose word is zero: a call through a null pointer.
        const call = [0xff, 0x15, 0x00, 0x01, 0x02, 0x00, 0xf4];
        const closed = host({ closedBelow: 0x10000 });
        load(closed, 0x20000, call);
        closed.runSlice(100);
        assert.equal(closed.fault()?.eip, 0, 'the fetch at address zero faults');

        // mov [0x10], eax; hlt
        const store = host({ closedBelow: 0x10000 });
        load(store, 0x20000, [0xa3, 0x10, 0, 0, 0, 0xf4]);
        store.runSlice(100);
        assert.equal(store.fault()?.eip, 0x20000, 'the store faults at its instruction');

        const open = host();
        load(open, 0x20000, [0xa3, 0x10, 0, 0, 0, 0xf4]);
        assert.equal(open.runSlice(100), 2);
        assert.equal(open.fault(), null);
    });
