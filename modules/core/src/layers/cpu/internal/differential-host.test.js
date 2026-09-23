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
        { replayed: 0, divergences: 0, handoffMisses: 0, first: null });
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
        { replayed: 1, divergences: 0, handoffMisses: 0, first: null });
});

test('without the snapshot machinery the differential host refuses', ()=>{
    assert.throws(()=>createDifferentialHost({
        emulator: fakeEmulator(),
        cork: /** @type {any} */ ({ entryOf: ()=>-1, holdsPage: ()=>false, diagnostics: ()=>({}) }),
        engine: {},
    }), /snapshot, restore and compare/);
});
