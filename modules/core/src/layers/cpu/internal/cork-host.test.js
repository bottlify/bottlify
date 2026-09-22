/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cork host without an emulator: its own memory and layout, the state
 * block captured and restored whole, the eager flags word, and the cpu api's
 * context over it. Nothing in this file runs guest code; the interpreter tier
 * over a small program is `cork-host.itest.js`.
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

test('the host boots a real runtime over cork\'s own memory', ()=>{
    const h = host();
    assert.equal(h.engine(), 'cork');
    assert.ok(h.cork(), 'the translator runtime is built');
    assert.equal(h.readReg32('eflags'), 0x2, 'the boot eflags word');
    assert.equal(h.controlRegister(0), 1, 'PE is set: flat 32-bit protected mode');
    assert.equal(h.controlRegister(3), 0, 'and no CR3');
    assert.equal(h.inProtectedMode(), true);
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
