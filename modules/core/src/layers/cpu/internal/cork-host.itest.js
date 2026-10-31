/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cork host runs with nothing of the emulator loaded: its own memory and
 * the engine loaded by URL. Step 5.2 wires the interpreter
 * tier in, so an address the translator has no entry for runs on cork's own
 * decoder and evaluator; an instruction the evaluator has no model for is an
 * invalid-opcode fault, and a fault becomes the host's fault record.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from './cork-host.js';
import * as engine from '../../../../../cork/src/index.js';

const ENTRY_VECTOR = 0x7000;

/**
 * A host over the engine module, with nothing of the emulator loaded, its
 * slices ended by their instruction count alone: an interpreted slice
 * otherwise ends once it has taken its time (`sliceMs`), and with eight busy
 * loops beside the suite one ended at the trap, short of the hlt after it.
 */
function host(){
    return createCorkHost({
        engine,
        memorySize: 1 << 20,
        trapPort: 0x1234,
        entryVector: ENTRY_VECTOR,
        initialStack: 0x300000,
        cork: { sliceMs: Infinity },
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
    load(h, 0x11000, [0xb8, 0x34, 0x12, 0, 0, 0x40, 0xf4]);
    assert.equal(h.runSlice(100), 3);
    assert.equal(h.readReg32('eax') >>> 0, 0x1235);
    assert.equal(h.readReg32('eip') >>> 0, 0x11007);
    assert.equal(h.haltedFlag(), 1);
});

test('an instruction with no model is an invalid-opcode fault the program can take', ()=>{
    const h = host();
    // lar eax, [eax], which no user program runs and the model has no case for.
    load(h, 0x11000, [0x0f, 0x02, 0x00]);
    h.runSlice(1);
    assert.equal(h.fault()?.vector, 6, '#UD');
});

test('the fault and the diagnostics name the instruction met, not the range it started at',
    ()=>{
        const h = host();
        // Three nops then lar eax, [eax]: the run starts at 0x11000, the instruction
        // with no model is at 0x11003.
        load(h, 0x11000, [0x90, 0x90, 0x90, 0x0f, 0x02, 0x00, 0xf4]);
        h.runSlice(100);
        assert.equal(h.fault()?.eip, 0x11003);
        assert.deepEqual(h.corkDiagnostics().untiered, ['0x0f (0f 02) at 0x00011003']);
    });

test('an interpreted trap reaches the call channel', ()=>{
    const h = host();
    // mov edx, trap port; mov eax, 0x1234; out dx, eax; hlt -- a write to any
    // other port is a device's.
    load(h, 0x11000, [0xba, 0x34, 0x12, 0, 0, 0xb8, 0x34, 0x12, 0, 0, 0xef, 0xf4]);
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
    load(h, 0x11000, [0x31, 0xd2, 0x31, 0xc0, 0xf7, 0xf2]);
    h.runSlice(10);
    const fault = h.fault();
    assert.ok(fault, 'a fault record was built');
    assert.equal(fault.vector, 0);
    assert.equal(h.haltedFlag(), 1);
});

test('a fault is offered to the handler first, and one it takes goes on where it says', ()=>{
    const h = host();
    // mov edx, 7; xor eax, eax; mov ecx, eax; div ecx -- #DE with edx and the stack known.
    load(h, 0x11000, [0xba, 7, 0, 0, 0, 0x31, 0xc0, 0x89, 0xc1, 0xf7, 0xf1]);
    // At 0x12000: mov eax, 0x55; hlt -- where the handler sends it.
    h.writePhysical(0x12000, Uint8Array.from([0xb8, 0x55, 0, 0, 0, 0xf4]));
    /** @type {any[]} */
    const offered = [];
    h.onFault((/** @type {any} */ fault)=>{
        offered.push(fault);
        h.writeReg32('eip', 0x12000);
        return true;
    });

    h.runSlice(10);
    assert.equal(offered.length, 1);
    assert.equal(offered[0].vector, 0);
    assert.equal(offered[0].eip, 0x11009, 'at the divide');
    assert.equal(offered[0].edx, 7, 'with the registers a ROM stub would have saved');
    assert.equal(offered[0].stack, 0x300000, 'and the faulting code\'s own stack');
    assert.equal(h.fault(), null, 'a fault the handler took is not the machine\'s');

    h.runSlice(10);
    assert.equal(h.readReg32('eax') >>> 0, 0x55, 'the thread went on where the handler put it');
});

test('a fault the handler declines stops the machine as before', ()=>{
    const h = host();
    load(h, 0x11000, [0x31, 0xd2, 0x31, 0xc0, 0xf7, 0xf2]);
    h.onFault(()=>false);
    h.runSlice(10);
    assert.equal(h.fault()?.vector, 0);
    assert.equal(h.haltedFlag(), 1);
});

test('an interpreted access beyond RAM is a page fault at the instruction, with its address', ()=>{
    const h = host();
    // mov eax, [eax]; hlt -- eax points past the 1 MiB of guest RAM.
    load(h, 0x11000, [0x8b, 0x00, 0xf4]);
    h.writeReg32('eax', 0x200000);
    h.runSlice(10);
    const fault = h.fault();
    assert.ok(fault, 'a fault record was built');
    assert.equal(fault.vector, 14, 'as Windows raises an access violation: #PF');
    assert.equal(fault.address, 0x200000, 'the address it could not reach');
    assert.equal(fault.errorCode, 0, 'a read of a page not present');
    assert.equal(fault.eip, 0x11000, 'at the faulting instruction');
    assert.equal(h.haltedFlag(), 1);
});

test('an interpreted store into a translated page invalidates the region', async()=>{
    const h = host();
    const runtime = h.cork();
    // A region at 0x11000: mov eax, 1; hlt.
    h.writePhysical(0x11000, Uint8Array.from([0xb8, 1, 0, 0, 0, 0xf4]));
    runtime.noteHot(0x11000);
    assert.equal(await runtime.translatePending(), 1, 'the region was formed');
    assert.equal(runtime.holdsPage(0x11000 >>> 12), true);
    // At 0x12000 the interpreter stores into the region's page and halts. The
    // write goes through the same page-flag check a translated store uses.
    load(h, 0x12000, [0xb8, 0, 0x10, 0x01, 0, 0x89, 0x00, 0xf4]);
    h.runSlice(100);
    assert.equal(runtime.holdsPage(0x11000 >>> 12), false, 'the region was dropped');
});

test('eight bytes copied through the x87 arrive whole however the slices cut the copy', ()=>{
    // A Delphi program's Move copies eight bytes at a time by fild qword and
    // fistp qword; a quadword is exact on the processor, and a slice -- or a
    // run of either interpreter -- ending between the load and the store must
    // not round it through a double. "C:\I" and ".exe" as UTF-16 have more
    // bits than a double keeps.
    const words = [0x0049005c003a0043n, 0x006500780065002en];
    for (const slice of [1, 2, 3, 1000])
    {
        const h = host();
        const data = new Uint8Array(16);
        words.forEach((word, i)=>new DataView(data.buffer).setBigUint64(i * 8, word, true));
        h.writePhysical(0x12000, data);
        // fild qword [0x12000]; fild qword [0x12008]; fistp qword [0x13008];
        // fistp qword [0x13000]; hlt
        load(h, 0x11000, [0xdf, 0x2d, 0, 0x20, 0x01, 0, 0xdf, 0x2d, 8, 0x20, 0x01, 0,
            0xdf, 0x3d, 8, 0x30, 0x01, 0, 0xdf, 0x3d, 0, 0x30, 0x01, 0, 0xf4]);
        for (let guard = 0; !h.haltedFlag() && guard < 100; guard++)
        {
            h.runSlice(slice);
        }
        const read = h.readPhysical(0x13000, 16);
        const out = new DataView(read.buffer, read.byteOffset, 16);
        assert.deepEqual([out.getBigUint64(0, true), out.getBigUint64(8, true)], words,
            `slices of ${slice}`);
    }
});

test('long mode on the shared runtime steps a self-patching routine an instruction at a time',
    ()=>{
        const h = createCorkHost({ engine, memorySize: 16 << 20, trapPort: 0x1234,
            entryVector: ENTRY_VECTOR, initialStack: 0x300000, bits: 64,
            cork: { sliceMs: Infinity } });
        // At 0x11000: for ebx in 0..2999, r12d += scale(edi = ebx, esi = ebx & 3); hlt.
        // At 0x12000, scale: cmp [add's imm], esi; je; mov [add's imm], esi;
        // imul eax, edi, 0x12345678; add eax, imm; ret -- a store into its own page
        // three calls in four, so its region is dropped and each patch is a forced step.
        load(h, 0x11000, hex('31db4531e489de83e60389dfe8ef0f00004101c4ffc381fbb80b000075e7f4'));
        h.writePhysical(0x12000,
            Uint8Array.from(hex('39350f000000740689350700000069c7785634120545230100c3')));
        h.runSlice(100_000);
        while (!h.halted())
        {
            h.cork().translatePending().catch(()=>{});
            h.runSlice(100_000);
        }
        let sum = 0;
        for (let i = 0; i < 3000; i++)
        {
            sum = (sum + Math.imul(i, 0x12345678) + (i & 3)) >>> 0;
        }
        assert.equal(Number(h.readReg64('r12') & 0xffffffffn), sum);
        // A forced step that ran on to the next entry interpreted the caller's loop
        // whole after each patch, tens of instructions a call.
        const script = h.corkDiagnostics().interpretedByScript;
        assert.ok(script < 3000, `${script} instructions interpreted by the script`);
    });

test('long mode\'s writes to the trap port run translated on the shared runtime', async()=>{
    const h = createCorkHost({ engine, memorySize: 16 << 20, trapPort: 0x1234,
        entryVector: ENTRY_VECTOR, initialStack: 0x300000, bits: 64,
        cork: { sliceMs: Infinity } });
    // For ebx in 0..1999: mov edx, port; mov eax, ebx; out dx, eax; add r12, rax; hlt.
    load(h, 0x11000, hex('31dbba3412000089d8ef4901c4ffc381fbd007000075ebf4'));
    let calls = 0;
    // The handler answers in rax, as a host call's does.
    h.onTrap((/** @type {number} */ value)=>{
        calls++;
        h.writeReg64('rax', BigInt(value) * 3n);
    });
    // A slice of a few hundred instructions, the region formed before the next.
    h.runSlice(300);
    while (!h.halted())
    {
        await h.cork().translatePending();
        h.runSlice(300);
    }
    assert.equal(calls, 2000);
    assert.equal(h.readReg64('r12'), 3n * 1999000n);
    const { interpreted } = h.corkDiagnostics();
    assert.ok(interpreted < 1000, `${interpreted} instructions interpreted`);
});

/** @param {string} text */
function hex(text){
    return (text.match(/../g) ?? []).map(byte=>parseInt(byte, 16));
}
