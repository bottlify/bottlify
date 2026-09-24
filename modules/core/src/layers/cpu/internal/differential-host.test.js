/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDifferentialHost } from './differential-host.js';

/** An emulator host enough for the differential slice loop. Its `eip` and its
 * snapshot view agree, and its slice moves `at` to the region's exit, so the
 * replay's address alignment lands. */
function fakeEmulator(){
    const machine = {
        at: 0x1000, stopped: false, slices: /** @type {number[]} */ ([]),
        readReg32: (/** @type {string} */ name)=>(name === 'eip' ? machine.at : 0),
        runSlice(/** @type {number} */ n){
            machine.slices.push(n);
            machine.at = 0x2000; // the region's exit, as the code would reach it
            return 1;
        },
        halt(){
            machine.stopped = true;
        },
        halted: ()=>machine.stopped,
        eip: ()=>machine.at,
        x87Top: ()=>0,
        raiseTrap: ()=>undefined,
        handoffAvailable: ()=>false,
    };
    return machine;
}

/** A snapshot/restore/compare that round-trips eip, for the replay.
 * @param {any[]} diff */
function fakeEngine(diff){
    return {
        snapshot: (/** @type {any} */ host)=>({ eip: host.eip() }),
        restore: (/** @type {any} */ host, /** @type {any} */ state)=>{
            if (typeof state?.eip === 'number')
            {
                host.at = state.eip;
            }
        },
        compare: ()=>diff,
    };
}

/** A cork runtime whose one region retires 4 and leaves untranslated.
 * @param {any} emulator */
function fakeCork(emulator){
    return /** @type {any} */ ({
        entryOf: (/** @type {number} */ eip)=>(eip === 0x1000 ? 7 : -1),
        holdsPage: ()=>false,
        run(){
            emulator.at = 0x2000;
            return { retired: 4, kind: 'untranslated', vector: 0 };
        },
        diagnostics: ()=>({}),
    });
}

test('the differential host names itself', ()=>{
    const host = createDifferentialHost({ emulator: fakeEmulator(), cork: null, engine: {} });
    assert.equal(host.engine(), 'differential');
    assert.deepEqual(host.differentialDiagnostics(),
        { replayed: 0, divergences: 0, handoffMisses: 0,
            skipped: { hostCalls: 0, overran: 0, budget: 0 }, first: null });
});

test('a region run is replayed and a divergence is recorded', ()=>{
    const emulator = fakeEmulator();
    const host = createDifferentialHost({
        emulator,
        cork: fakeCork(emulator),
        engine: fakeEngine([{ name: 'eax', expected: 1, actual: 2 }]),
    });
    host.runSlice(10);
    const report = host.differentialDiagnostics();
    assert.equal(report.replayed, 1);
    assert.equal(report.divergences, 1);
    assert.equal(report.first.at, '0x00001000');
    assert.deepEqual(report.first.diff, [{ name: 'eax', expected: 1, actual: 2 }]);
});

test('an agreeing replay records no divergence', ()=>{
    const emulator = fakeEmulator();
    const host = createDifferentialHost({
        emulator,
        cork: fakeCork(emulator),
        engine: fakeEngine([]),
    });
    host.runSlice(10);
    assert.deepEqual(host.differentialDiagnostics(),
        { replayed: 1, divergences: 0, handoffMisses: 0,
            skipped: { hostCalls: 0, overran: 0, budget: 0 }, first: null });
});

test('without the snapshot machinery the differential host refuses', ()=>{
    assert.throws(()=>createDifferentialHost({
        emulator: fakeEmulator(),
        cork: /** @type {any} */ ({ entryOf: ()=>-1, holdsPage: ()=>false, diagnostics: ()=>({}) }),
        engine: {},
    }), /snapshot, restore and compare/);
});

/** A machine whose one region increments a counter in memory: the translator
 * run and the emulator's replay each add one, as `inc dword [0x3000]` does.
 * @param {{ callHost?: boolean }} [options] */
function counterMachine({ callHost = false } = {}){
    const emulator = /** @type {any} */ (fakeEmulator());
    emulator.mem = new Uint8Array(0x4000);
    emulator.writePhysical = (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>{
        emulator.mem.set(bytes, at);
    };
    emulator.hostCalls = 0;
    emulator.raiseTrap = ()=>{
        emulator.hostCalls++;
    };
    emulator.runSlice = ()=>{
        emulator.mem[0x3000]++;
        emulator.at = 0x2000;
        return 1;
    };
    /** @type {{ address: number, size: number, old: Uint8Array }[]} */
    let ring = [];
    const cork = /** @type {any} */ ({
        entryOf: (/** @type {number} */ eip)=>(eip === 0x1000 ? 7 : -1),
        holdsPage: ()=>false,
        run(){
            ring.push({ address: 0x3000, size: 4, old: emulator.mem.slice(0x3000, 0x3004) });
            emulator.mem[0x3000]++;
            if (callHost)
            {
                emulator.raiseTrap(0);
            }
            emulator.at = 0x2000;
            return { retired: 1, kind: 'untranslated', vector: 0 };
        },
        diagnostics: ()=>({}),
    });
    const engine = {
        /** @param {any} host @param {{ address: number, length: number }[]} spans */
        snapshot: (host, spans)=>({
            eip: host.eip(),
            memory: spans.map(span=>({
                address: span.address,
                bytes: host.mem.slice(span.address, span.address + span.length),
            })),
        }),
        restore: (/** @type {any} */ host, /** @type {any} */ state)=>{
            host.at = state.eip;
            for (const { address, bytes } of state.memory)
            {
                host.mem.set(bytes, address);
            }
        },
        compare: (/** @type {any} */ a, /** @type {any} */ b)=>a.memory
            .filter((/** @type {any} */ span, /** @type {number} */ i)=>
                span.bytes.some((/** @type {number} */ v, /** @type {number} */ j)=>v !== b.memory[i].bytes[j]))
            .map(()=>({ name: 'mem', expected: 0, actual: 0 })),
        resetUndoLog: ()=>{
            ring = [];
        },
        readUndoLog: ()=>({ entries: ring, wrapped: false }),
        spansOf: (/** @type {{ address: number, size: number }[]} */ entries)=>
            entries.map(({ address, size })=>({ start: address, end: address + size })),
    };
    const host = createDifferentialHost({
        emulator, cork, engine, memory: /** @type {any} */ ({}), layout: {},
    });
    return { emulator, host };
}

test('a region that increments memory is replayed on the bytes it found', ()=>{
    const { emulator, host } = counterMachine();
    host.runSlice(1);
    const report = host.differentialDiagnostics();
    assert.equal(report.replayed, 1);
    assert.equal(report.divergences, 0, 'the store was rewound before the emulator ran it');
    assert.equal(emulator.mem[0x3000], 1, 'the guest goes on with one increment, not two');
});

test('a region that called the host is not replayed', ()=>{
    const { emulator, host } = counterMachine({ callHost: true });
    host.runSlice(1);
    const report = host.differentialDiagnostics();
    assert.equal(report.replayed, 0);
    assert.deepEqual(report.skipped, { hostCalls: 1, overran: 0, budget: 0 });
    assert.equal(emulator.hostCalls, 1, 'the handler ran once');
    assert.equal(emulator.mem[0x3000], 1);
});

test('a replay that calls into translated code steps through the callee\'s entry', async()=>{
    const { Tables, slotOf, readUndoLog, resetUndoLog, spansOf } = await import(
        '../../../../../cork/src/index.js');
    const memory = new WebAssembly.Memory({ initial: Math.ceil(Tables.SIZE / 65536) + 1 });
    const layout = { tables: 0 };
    const view = new DataView(memory.buffer);
    const CALLEE = 0x1500;
    const slotAt = Tables.HASH + slotOf(CALLEE) * Tables.HASH_SLOT;
    view.setUint32(slotAt, CALLEE, true);
    const emulator = /** @type {any} */ (fakeEmulator());
    emulator.writePhysical = ()=>undefined;
    // The emulator's handoff: standing on an address the hash holds, it
    // returns without running anything.
    emulator.runSlice = ()=>{
        if (emulator.at === 0x1000)
        {
            emulator.at = CALLEE;
            return 1;
        }
        if (emulator.at === CALLEE && view.getUint32(slotAt, true) !== CALLEE)
        {
            emulator.at = 0x2000;
            return 1;
        }
        return 0;
    };
    const engine = {
        ...fakeEngine([]), Tables, slotOf, readUndoLog, resetUndoLog, spansOf,
    };
    const host = createDifferentialHost({
        emulator, cork: fakeCork(emulator), engine, memory, layout,
    });
    host.runSlice(10);
    const report = host.differentialDiagnostics();
    assert.equal(report.replayed, 1);
    assert.equal(report.divergences, 0, 'the emulator reached the exit past the callee');
    assert.equal(view.getUint32(slotAt, true), CALLEE, 'and the entry is back in the hash');
});
