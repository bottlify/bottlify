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
import { createCorkHost } from './cork-host.js';
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
    loop.runSlice(1 << 16);
    assert.equal(loop.instructionCount(), 4002);
});

test('a slice that dies on a no-tier instruction still counts what it ran', ()=>{
    const h = host();
    // Four nops, then sldt [eax]: the model has no case for it.
    load(h, 0x1000, [0x90, 0x90, 0x90, 0x90, 0x0f, 0x00, 0x00, 0xf4]);
    assert.throws(()=>h.runSlice(100), /no tier for 0x0f/);
    assert.equal(h.instructionCount(), 4, 'the four nops it ran, not the one it stopped on');
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
