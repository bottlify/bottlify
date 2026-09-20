/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridHost } from './hybrid-host.js';

/** An emulator host that records what it is asked. */
function fakeEmulator(){
    /** @type {[string, any[]][]} */
    const calls = [];
    /** @param {string} name */
    const record = name=>(/** @type {any[]} */ ...args)=>{
        calls.push([name, args]);
        return `${name}:answer`;
    };
    return {
        calls,
        runSlice: record('runSlice'),
        readReg32: record('readReg32'),
        writePhysical: record('writePhysical'),
        onTrap: record('onTrap'),
        halt: record('halt'),
        stop: record('stop'),
        instructionCount: record('instructionCount'),
        romBase: 0xf0000,
        profile: { available: ()=>false },
    };
}

test('with no translator, every member of the emulator host is forwarded as is', ()=>{
    const emulator = fakeEmulator();
    const host = createHybridHost({ emulator, cork: null });

    for (const key of Object.keys(emulator))
    {
        assert.ok(key in host, `the hybrid host lacks "${key}"`);
    }
    assert.equal(host.runSlice(1000), 'runSlice:answer');
    assert.equal(host.readReg32('eax'), 'readReg32:answer');
    host.writePhysical(0x8000, new Uint8Array([1, 2]));
    host.onTrap(()=>{});
    host.halt();
    assert.deepEqual(emulator.calls.map(([name])=>name),
        ['runSlice', 'readReg32', 'writePhysical', 'onTrap', 'halt']);
    assert.deepEqual(emulator.calls[0][1], [1000], 'arguments arrive as given');
    assert.deepEqual(emulator.calls[1][1], ['eax']);
    assert.equal(host.romBase, 0xf0000, 'a constant is the same value');
    assert.equal(host.profile, emulator.profile, 'the profile object is the same object');
});

test('the hybrid host names itself and reports the translator it has, or none', ()=>{
    const bare = createHybridHost({ emulator: fakeEmulator(), cork: null });
    assert.equal(bare.engine(), 'hybrid');
    assert.equal(bare.corkDiagnostics(), null);

    const diagnostics = { regions: 3 };
    const attached = createHybridHost({
        emulator: fakeEmulator(),
        cork: /** @type {any} */ ({ diagnostics: ()=>diagnostics }),
    });
    assert.equal(attached.corkDiagnostics(), diagnostics);
});

/** An emulator whose slices retire what they are given, standing at one EIP. */
function fakeMachine(){
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
        x87Top: ()=>0,
        eip: ()=>machine.at,
    };
    return machine;
}

test('the slice: the translator runs while it has an entry, the emulator takes the rest', ()=>{
    const emulator = fakeMachine();
    /** @type {{ entry: number, budget: number }[]} */
    const runs = [];
    const exits = [
        { retired: 4, kind: 'untranslated', vector: 0 },
    ];
    const cork = /** @type {any} */ ({
        entryOf: (/** @type {number} */ eip)=>(eip === 0x1000 ? 7 : -1),
        run(/** @type {number} */ entry, /** @type {number} */ budget){
            runs.push({ entry, budget });
            const exit = exits.shift();
            emulator.at = 0x2000;
            return exit;
        },
        diagnostics: ()=>({ regions: 1 }),
    });
    const host = createHybridHost({ emulator, cork });
    assert.equal(host.runSlice(10), 10);
    assert.deepEqual(runs, [{ entry: 7, budget: 10 }]);
    assert.deepEqual(emulator.slices, [6], 'the emulator got what was left');
    assert.equal(host.cork(), cork);
});

test('the slice: a budget exit ends the slice, a halt halts, a stale exit continues', ()=>{
    const emulator = fakeMachine();
    /** @type {any[]} */
    const exits = [
        { retired: 3, kind: 'stale', vector: 0 },
        { retired: 7, kind: 'budget', vector: 0 },
    ];
    const cork = /** @type {any} */ ({
        entryOf: ()=>1,
        run: ()=>exits.shift(),
        diagnostics: ()=>({}),
    });
    const host = createHybridHost({ emulator, cork });
    assert.equal(host.runSlice(10), 10);
    assert.deepEqual(emulator.slices, [], 'nothing left for the emulator');
    const halting = fakeMachine();
    const stopper = /** @type {any} */ ({
        entryOf: ()=>1,
        run: ()=>({ retired: 2, kind: 'halt', vector: 0 }),
        diagnostics: ()=>({}),
    });
    const stopped = createHybridHost({ emulator: halting, cork: stopper });
    assert.equal(stopped.runSlice(10), 2);
    assert.equal(halting.stopped, true);
    assert.deepEqual(halting.slices, []);
});

test('the slice: a fault exit hands the instruction to the emulator', ()=>{
    const emulator = fakeMachine();
    const cork = /** @type {any} */ ({
        entryOf: ()=>1,
        run: ()=>{
            emulator.at = 0x1004;
            return { retired: 1, kind: 'fault', vector: 13 };
        },
        diagnostics: ()=>({}),
    });
    const host = createHybridHost({ emulator, cork });
    assert.equal(host.runSlice(10), 10);
    assert.deepEqual(emulator.slices, [9]);
});
