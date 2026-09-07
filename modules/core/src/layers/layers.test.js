/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleModules } from '../core.js';

const ALL_LAYERS = [
    'log',
    'cpu',
    'memory',
    'kernel',
    'bridge',
    'loader',
    'filesystem',
    'win32',
    'graphics',
    'audio',
    'input',
];

/** Layers with a real implementation; the rest are still stubs. */
const IMPLEMENTED = [
    'log', 'cpu', 'memory', 'kernel', 'bridge', 'loader', 'filesystem', 'win32', 'graphics',
    'audio', 'input',
];

test('a default build contains every layer, in dependency order', async()=>{
    const core = await assembleModules({});
    const diag = core.diagnostics();
    assert.deepEqual(diag.map(d=>d.name), ALL_LAYERS);

    for (const entry of diag)
    {
        if (IMPLEMENTED.includes(entry.name))
        {
            assert.notEqual(entry.status, 'stub', `${entry.name} is implemented`);
        }
        else
        {
            assert.equal(entry.status, 'stub', `${entry.name} is not built yet`);
        }
    }
});

test('building the graph costs nothing: the emulator is not started', async()=>{
    const core = await assembleModules({});
    const cpu = core.api('cpu');

    assert.equal(cpu.booted(), false);
    // Anything needing a running guest says so plainly instead of failing deeper.
    assert.throws(()=>cpu.run(), /boot\(\) must be called/);
    assert.throws(()=>cpu.readReg32('eax'), /boot\(\) must be called/);
});

test('a layer that is not built refuses loudly', async()=>{
    // What matters is that an interface nobody implements refuses rather than
    // answering with a plausible nothing -- a silent zero from a layer that is
    // not there is a defect that surfaces wherever the caller used it.
    //
    // Driven through a *disabled* module rather than an unbuilt one: every
    // layer now has an implementation, and the stub is what a module something
    // still requires is replaced by when it is switched off. That is the same
    // mechanism and the one that will still exist in a finished engine.
    const core = await assembleModules({ win32: false });
    assert.throws(()=>core.api('win32').anything(), { code: 'NOT_IMPLEMENTED' });
});

test('disabling a leaf nobody requires removes it from the build', async()=>{
    const core = await assembleModules({ graphics: false });
    const names = core.diagnostics().map(d=>d.name);
    assert.ok(!names.includes('graphics'));
    assert.throws(()=>core.api('graphics'), /not part of this build/);
});

test('disabling a required module installs a stub in its place', async()=>{
    const core = await assembleModules({ win32: false });
    const win32 = core.diagnostics().find(d=>d.name === 'win32');
    assert.ok(win32);
    assert.equal(win32.status, 'stub');
    assert.ok(core.diagnostics().some(d=>d.name === 'graphics'),
        'win32 stays because graphics requires it');
});

test('configuration errors propagate', async()=>{
    await assert.rejects(()=>assembleModules({ ghost: true }), /Unknown module/);
    await assert.rejects(()=>assembleModules({ log: 'loud' }), /expected boolean\/null\/object/);
});

test('dispose resolves and keeps the instance queryable', async()=>{
    const core = await assembleModules({});
    await core.dispose();
    assert.equal(core.diagnostics().length, ALL_LAYERS.length);
});
