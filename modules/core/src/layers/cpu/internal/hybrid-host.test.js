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
    assert.deepEqual(attached.corkDiagnostics(), { ...diagnostics, handoffMisses: 0 },
        "the translator's report, with the host's own miss count");
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
        holdsPage: ()=>false,
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
        holdsPage: ()=>false,
        run: ()=>exits.shift(),
        diagnostics: ()=>({}),
    });
    const host = createHybridHost({ emulator, cork });
    assert.equal(host.runSlice(10), 10);
    assert.deepEqual(emulator.slices, [], 'nothing left for the emulator');
    const halting = fakeMachine();
    const stopper = /** @type {any} */ ({
        entryOf: ()=>1,
        holdsPage: ()=>false,
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
        holdsPage: ()=>false,
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

test('a host write into guest memory invalidates the translator on every page it touches', ()=>{
    const emulator = fakeMachine();
    /** @type {number[]} */
    const invalidated = [];
    /** @type {[string, number, number][]} */
    const writes = [];
    Object.assign(emulator, {
        writePhysical: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>{
            writes.push(['physical', a, b.length]);
        },
        writeData: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>{
            writes.push(['data', a, b.length]);
            return 'written';
        },
        fillData: (/** @type {number} */ a, /** @type {number} */ v, /** @type {number} */ n)=>{
            writes.push(['fill', a, n]);
        },
    });
    const cork = /** @type {any} */ ({
        entryOf: ()=>-1,
        holdsPage: ()=>false,
        run: ()=>({ retired: 0, kind: 'untranslated', vector: 0 }),
        invalidatePage: (/** @type {number} */ page)=>invalidated.push(page),
        diagnostics: ()=>({}),
    });
    const host = createHybridHost({ emulator, cork });
    host.writePhysical(0x1ffe, new Uint8Array(4));            // spans pages 1 and 2
    assert.deepEqual(invalidated, [1, 2]);
    assert.equal(host.writeData(0x5000, new Uint8Array(0x1000)), 'written');
    assert.deepEqual(invalidated, [1, 2, 5], 'exactly the one page');
    host.fillData(0x7ff0, 0, 0x20);
    assert.deepEqual(invalidated, [1, 2, 5, 7, 8]);
    host.writePhysical(0x9000, new Uint8Array(0));
    assert.deepEqual(invalidated, [1, 2, 5, 7, 8], 'an empty write touches nothing');
    assert.deepEqual(writes.map(([kind])=>kind), ['physical', 'data', 'fill', 'physical'],
        'every write still reaches the emulator');
    const bare = createHybridHost({ emulator, cork: null });
    bare.writePhysical(0x1000, new Uint8Array(1));
    assert.deepEqual(invalidated, [1, 2, 5, 7, 8], 'without a translator, nothing to invalidate');
});

/**
 * An emulator that runs a scripted list of turns and has the handoff export.
 * @param {{ retired: number, eip: number }[]} turns @param {{ handoff?: boolean }} [options]
 */
function scriptedMachine(turns, { handoff = true } = {}){
    const machine = {
        at: 0x1000, stopped: false, slices: /** @type {number[]} */ ([]),
        readReg32: ()=>0,
        runSlice(/** @type {number} */ n){
            machine.slices.push(n);
            const turn = turns.shift();
            if (!turn)
            {
                return n;
            }
            machine.at = turn.eip;
            return turn.retired;
        },
        halt(){
            machine.stopped = true;
        },
        halted: ()=>machine.stopped,
        eip: ()=>machine.at,
        x87Top: ()=>0,
        handoffAvailable: ()=>handoff,
    };
    return machine;
}

test('with the handoff export the loop goes round: emulator, translator, emulator', ()=>{
    // The emulator stops after 3 at a translated address; cork runs 4 and
    // leaves untranslated at an address without an entry; the emulator takes
    // the remaining 3 and stops at another translated address.
    const emulator = scriptedMachine([{ retired: 3, eip: 0x2000 }, { retired: 3, eip: 0x2000 }]);
    /** @type {number[]} */
    const budgets = [];
    const cork = /** @type {any} */ ({
        entryOf: (/** @type {number} */ eip)=>(eip === 0x2000 ? 1 : -1),
        run(/** @type {number} */ entry, /** @type {number} */ budget){
            budgets.push(budget);
            emulator.at = 0x3000;
            return { retired: 4, kind: 'untranslated', vector: 0 };
        },
        diagnostics: ()=>({}),
    });
    const host = createHybridHost({ emulator, cork });
    assert.equal(host.runSlice(10), 10);
    assert.deepEqual(emulator.slices, [10, 3], 'the emulator is given what remains each time');
    assert.deepEqual(budgets, [7], "the translator took the emulator's remainder");
    assert.equal(host.corkDiagnostics().handoffMisses, 0);
});

test('without the export a stop at a translated address is a miss and ends the slice', ()=>{
    const emulator = scriptedMachine([{ retired: 3, eip: 0x2000 }], { handoff: false });
    const cork = /** @type {any} */ ({
        entryOf: (/** @type {number} */ eip)=>(eip === 0x2000 ? 1 : -1),
        holdsPage: (/** @type {number} */ page)=>page === 2,
        run: ()=>{
            throw new Error('not reached');
        },
        diagnostics: ()=>({ regions: 1 }),
    });
    const host = createHybridHost({ emulator, cork });
    assert.equal(host.runSlice(10), 3);
    assert.deepEqual(emulator.slices, [10]);
    assert.deepEqual(host.corkDiagnostics(), { regions: 1, handoffMisses: 1 });
});

test('a trap exit raises the emulator\'s own trap handler and the slice goes on', ()=>{
    const emulator = scriptedMachine([]);
    /** @type {number[]} */
    const raised = [];
    Object.assign(emulator, {
        readReg32: (/** @type {string} */ name)=>(name === 'eax' ? 0x2a : 0),
        raiseTrap: (/** @type {number} */ value)=>{
            raised.push(value);
            emulator.at = 0x4000; // the handler moved EIP, as a hook may
        },
    });
    let runs = 0;
    const cork = /** @type {any} */ ({
        entryOf: (/** @type {number} */ eip)=>(eip === 0x1000 || eip === 0x4000 ? 1 : -1),
        holdsPage: ()=>false,
        run(){
            runs++;
            if (runs === 1)
            {
                emulator.at = 0x1010;
                return { retired: 3, kind: 'trap', vector: 0 };
            }
            emulator.stopped = true;
            return { retired: 2, kind: 'halt', vector: 0 };
        },
        diagnostics: ()=>({}),
    });
    const host = createHybridHost({ emulator, cork });
    assert.equal(host.runSlice(10), 5);
    assert.deepEqual(raised, [0x2a], 'eax, as the port write would have carried it');
    assert.equal(runs, 2, 'the translator continued where the handler left EIP');
    assert.deepEqual(emulator.slices, [], 'the emulator ran nothing');
});
