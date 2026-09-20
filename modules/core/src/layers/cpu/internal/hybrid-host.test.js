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
