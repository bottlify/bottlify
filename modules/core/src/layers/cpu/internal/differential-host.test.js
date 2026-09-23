/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDifferentialHost } from './differential-host.js';

/** An emulator host enough for the differential slice loop. */
function fakeEmulator(){
    const machine = {
        at: 0x1000, stopped: false, slices: /** @type {number[]} */ ([]),
        readReg32: ()=>0,
        runSlice(/** @type {number} */ n){
            machine.slices.push(n);
            return n;
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

test('the differential host names itself', ()=>{
    const host = createDifferentialHost({ emulator: fakeEmulator(), cork: null, engine: {} });
    assert.equal(host.engine(), 'differential');
    assert.deepEqual(host.differentialDiagnostics(),
        { replayed: 0, divergences: 0, handoffMisses: 0, first: null });
});

test('a region run is replayed on the emulator and a divergence is recorded', ()=>{
    const emulator = fakeEmulator();
    /** @type {string[]} */
    const order = [];
    const engine = {
        snapshot: ()=>{
            order.push('snapshot');
            return { mark: order.length };
        },
        restore: ()=>{
            order.push('restore');
        },
        compare: ()=>{
            order.push('compare');
            return [{ name: 'eax', expected: 1, actual: 2 }];
        },
    };
    let at = 0;
    const cork = /** @type {any} */ ({
        entryOf: (/** @type {number} */ eip)=>(eip === 0x1000 ? 7 : -1),
        holdsPage: ()=>false,
        run(){
            at++;
            emulator.at = 0x2000;
            return { retired: 4, kind: 'untranslated', vector: 0 };
        },
        diagnostics: ()=>({}),
    });
    const host = createDifferentialHost({ emulator, cork, engine });
    assert.equal(host.runSlice(10), 10);
    assert.equal(at, 1, 'the region ran once');
    assert.deepEqual(order, ['snapshot', 'snapshot', 'restore', 'snapshot', 'compare', 'restore'],
        'snapshot before, snapshot the subject, restore, snapshot the oracle, compare, restore');
    assert.deepEqual(emulator.slices, [4, 6],
        'the oracle re-ran the region retired count, then took the remainder');
    const report = host.differentialDiagnostics();
    assert.equal(report.replayed, 1);
    assert.equal(report.divergences, 1);
    assert.equal(report.first.at, '0x00001000');
    assert.deepEqual(report.first.diff, [{ name: 'eax', expected: 1, actual: 2 }]);
});

test('an agreeing replay records no divergence', ()=>{
    const emulator = fakeEmulator();
    const engine = {
        snapshot: ()=>({}),
        restore: ()=>{},
        compare: ()=>[],
    };
    let at = 0;
    const cork = /** @type {any} */ ({
        entryOf: (/** @type {number} */ eip)=>(eip === 0x1000 ? 7 : -1),
        holdsPage: ()=>false,
        run(){
            at++;
            emulator.at = 0x2000;
            return { retired: 4, kind: 'untranslated', vector: 0 };
        },
        diagnostics: ()=>({}),
    });
    const host = createDifferentialHost({ emulator, cork, engine });
    host.runSlice(10);
    assert.equal(at, 1);
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
