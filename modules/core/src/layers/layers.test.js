/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBottlify } from '../core.js';

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

test('default build includes every layer as a stub', async()=>{
    const core = await createBottlify({});
    const diag = core.diagnostics();
    assert.deepEqual(diag.map(d=>d.name), ALL_LAYERS);
    for (const d of diag) assert.equal(d.status, 'stub');
});

test('every stub method throws NOT_IMPLEMENTED', async()=>{
    const core = await createBottlify({});
    assert.throws(()=>core.api('cpu').runQuantum(1), { code: 'NOT_IMPLEMENTED' });
    assert.throws(()=>core.api('win32').anyCallback(), { code: 'NOT_IMPLEMENTED' });
});

test('disabling a leaf nobody requires removes it from the build', async()=>{
    const core = await createBottlify({ graphics: false });
    const names = core.diagnostics().map(d=>d.name);
    assert.ok(!names.includes('graphics'));
    assert.throws(()=>core.api('graphics'), /not part of this build/);
});

test('disabling a required module installs a stub in its place', async()=>{
    const core = await createBottlify({ win32: false });
    const win32 = core.diagnostics().find(d=>d.name === 'win32');
    assert.ok(win32);
    assert.equal(win32.status, 'stub');
    assert.ok(core.diagnostics().some(d=>d.name === 'graphics'), 'win32 stays because graphics requires it');
});

test('configuration errors propagate', async()=>{
    await assert.rejects(()=>createBottlify({ ghost: true }), /Unknown module/);
    await assert.rejects(()=>createBottlify({ log: 'loud' }), /expected boolean\/null\/object/);
});

test('dispose resolves and keeps the instance queryable', async()=>{
    const core = await createBottlify({});
    await core.dispose();
    assert.equal(core.diagnostics().length, ALL_LAYERS.length);
});
