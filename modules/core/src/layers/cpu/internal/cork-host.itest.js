/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `engine: 'cork'` runs with nothing of the emulator loaded: the cork host's
 * own memory and the engine loaded by URL. Step 5.2 wires the interpreter
 * tier in, so an address the translator has no entry for runs on cork's own
 * decoder and evaluator; an instruction the evaluator has no model for is the
 * engine's no-tier answer, and a fault becomes the host's fault record.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from './cork-host.js';
import * as engine from '../../../../../cork/src/index.js';

const ENTRY_VECTOR = 0x7000;

/** A host over the engine module, with nothing of the emulator loaded. */
function host(){
    return createCorkHost({
        engine,
        memorySize: 1 << 20,
        trapPort: 0x1234,
        entryVector: ENTRY_VECTOR,
        initialStack: 0x300000,
        cork: {},
    });
}

/**
 * Writes a program and points the entry vector at it.
 *
 * @param {ReturnType<typeof host>} h @param {number} at @param {number[]} bytes
 */
function load(h, at, bytes){
    h.writePhysical(at, Uint8Array.from(bytes));
    const vector = new Uint8Array(4);
    new DataView(vector.buffer).setUint32(0, at, true);
    h.writePhysical(ENTRY_VECTOR, vector);
}

test('the interpreter tier runs what the translator has no entry for', ()=>{
    const h = host();
    // mov eax, 0x1234; inc eax; hlt
    load(h, 0x1000, [0xb8, 0x34, 0x12, 0, 0, 0x40, 0xf4]);
    assert.equal(h.runSlice(100), 3);
    assert.equal(h.readReg32('eax') >>> 0, 0x1235);
    assert.equal(h.readReg32('eip') >>> 0, 0x1007);
    assert.equal(h.haltedFlag(), 1);
});

test('an instruction with no model is the engine\'s no-tier answer', ()=>{
    const h = host();
    // sldt [eax]: no user program runs it, and the model has no case for it.
    load(h, 0x1000, [0x0f, 0x00, 0x00]);
    assert.throws(()=>h.runSlice(1), /cpu: cork has no tier for 0x/);
});

test('the no-tier answer names the instruction met, not the range it started at', ()=>{
    const h = host();
    // Three nops then sldt [eax]: the run starts at 0x1000, the instruction
    // with no model is at 0x1003.
    load(h, 0x1000, [0x90, 0x90, 0x90, 0x0f, 0x00, 0x00, 0xf4]);
    assert.throws(()=>h.runSlice(100),
        (/** @type {Error} */ e)=>/0x0f \(0f 00\) \(eip 0x00001003\)/.test(e.message));
});

test('an interpreted trap reaches the call channel', ()=>{
    const h = host();
    // mov eax, 0x1234; out dx, eax; hlt
    load(h, 0x1000, [0xb8, 0x34, 0x12, 0, 0, 0xef, 0xf4]);
    /** @type {number[]} */
    const traps = [];
    /** @param {number} value */
    const onTrap = value=>traps.push(value);
    h.onTrap(onTrap);
    h.runSlice(100);
    assert.deepEqual(traps, [0x1234]);
    assert.equal(h.trapCrossings(), 1);
    assert.equal(h.haltedFlag(), 1);
});

test('a fault becomes the fault record and stops the machine', ()=>{
    const h = host();
    // xor edx, edx; xor eax, eax; div edx  -- divide by zero, #DE.
    load(h, 0x1000, [0x31, 0xd2, 0x31, 0xc0, 0xf7, 0xf2]);
    h.runSlice(10);
    const fault = h.fault();
    assert.ok(fault, 'a fault record was built');
    assert.equal(fault.vector, 0);
    assert.equal(h.haltedFlag(), 1);
});

test('a fault is offered to the handler first, and one it takes goes on where it says', ()=>{
    const h = host();
    // mov edx, 7; xor eax, eax; mov ecx, eax; div ecx -- #DE with edx and the stack known.
    load(h, 0x1000, [0xba, 7, 0, 0, 0, 0x31, 0xc0, 0x89, 0xc1, 0xf7, 0xf1]);
    // At 0x2000: mov eax, 0x55; hlt -- where the handler sends it.
    h.writePhysical(0x2000, Uint8Array.from([0xb8, 0x55, 0, 0, 0, 0xf4]));
    /** @type {any[]} */
    const offered = [];
    h.onFault((/** @type {any} */ fault)=>{
        offered.push(fault);
        h.writeReg32('eip', 0x2000);
        return true;
    });

    h.runSlice(10);
    assert.equal(offered.length, 1);
    assert.equal(offered[0].vector, 0);
    assert.equal(offered[0].eip, 0x1009, 'at the divide');
    assert.equal(offered[0].edx, 7, 'with the registers a ROM stub would have saved');
    assert.equal(offered[0].stack, 0x300000, 'and the faulting code\'s own stack');
    assert.equal(h.fault(), null, 'a fault the handler took is not the machine\'s');

    h.runSlice(10);
    assert.equal(h.readReg32('eax') >>> 0, 0x55, 'the thread went on where the handler put it');
});

test('a fault the handler declines stops the machine as before', ()=>{
    const h = host();
    load(h, 0x1000, [0x31, 0xd2, 0x31, 0xc0, 0xf7, 0xf2]);
    h.onFault(()=>false);
    h.runSlice(10);
    assert.equal(h.fault()?.vector, 0);
    assert.equal(h.haltedFlag(), 1);
});

test('an interpreted access beyond RAM is a #GP at the instruction', ()=>{
    const h = host();
    // mov eax, [eax]; hlt -- eax points past the 1 MiB of guest RAM.
    load(h, 0x1000, [0x8b, 0x00, 0xf4]);
    h.writeReg32('eax', 0x200000);
    h.runSlice(10);
    const fault = h.fault();
    assert.ok(fault, 'a fault record was built');
    assert.equal(fault.vector, 13);
    assert.equal(fault.eip, 0x1000, 'at the faulting instruction');
    assert.equal(h.haltedFlag(), 1);
});

test('an interpreted store into a translated page invalidates the region', async()=>{
    const h = host();
    const runtime = h.cork();
    // A region at 0x1000: mov eax, 1; hlt.
    h.writePhysical(0x1000, Uint8Array.from([0xb8, 1, 0, 0, 0, 0xf4]));
    runtime.noteHot(0x1000);
    assert.equal(await runtime.translatePending(), 1, 'the region was formed');
    assert.equal(runtime.holdsPage(0x1000 >>> 12), true);
    // At 0x2000 the interpreter stores into the region's page and halts. The
    // write goes through the same page-flag check a translated store uses.
    load(h, 0x2000, [0xb8, 0, 0x10, 0, 0, 0x89, 0x00, 0xf4]);
    h.runSlice(100);
    assert.equal(runtime.holdsPage(0x1000 >>> 12), false, 'the region was dropped');
});
