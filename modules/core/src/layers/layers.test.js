/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testPageFile } from '../process/page-file.fixture.js';
import { roomy } from './cache/testing.fixture.js';
import { assembleModules } from '../core.js';

const ALL_LAYERS = [
    'log',
    'cache',
    'cpu',
    'memory',
    'kernel',
    'bridge',
    'loader',
    'filesystem',
    'media',
    'win32',
    'graphics',
    'audio',
    'input',
];

test('a default build contains every layer, in dependency order', async()=>{
    const core = await assembleModules({ filesystem: { pageFile: await testPageFile() },
        cache: { reader: roomy.reader } });
    const diag = core.diagnostics();
    assert.deepEqual(diag.map(d=>d.name), ALL_LAYERS);
});

test('building the graph costs nothing: the engine is not started', async()=>{
    const core = await assembleModules({ filesystem: { pageFile: await testPageFile() },
        cache: { reader: roomy.reader } });
    const cpu = core.api('cpu');

    assert.equal(cpu.booted(), false);
    // Anything needing a running guest says so plainly instead of failing deeper.
    assert.throws(()=>cpu.run(), /boot\(\) must be called/);
    assert.throws(()=>cpu.readReg32('eax'), /boot\(\) must be called/);
});

test('switching off a layer another requires fails the build, naming it', async()=>{
    // A layer something needs is never stood in for: a build without it would
    // answer its callers with refusals nobody learns of until they are met.
    const pageFile = await testPageFile();
    await assert.rejects(()=>assembleModules({ win32: false, filesystem: { pageFile },
        cache: { reader: roomy.reader } }),
    /Module "win32" is required by "(graphics|audio|input)" and is switched off/);
});

test('disabling a leaf nobody requires removes it from the build', async()=>{
    const core = await assembleModules({ graphics: false,
        filesystem: { pageFile: await testPageFile() },
        cache: { reader: roomy.reader } });
    const names = core.diagnostics().map(d=>d.name);
    assert.ok(!names.includes('graphics'));
    assert.throws(()=>core.api('graphics'), /not part of this build/);
});

test('configuration errors propagate', async()=>{
    await assert.rejects(()=>assembleModules({ ghost: true }), /Unknown module/);
    await assert.rejects(()=>assembleModules({ log: 'loud' }), /expected boolean\/null\/object/);
});

test('dispose resolves and keeps the instance queryable', async()=>{
    const core = await assembleModules({ filesystem: { pageFile: await testPageFile() },
        cache: { reader: roomy.reader } });
    await core.dispose();
    assert.equal(core.diagnostics().length, ALL_LAYERS.length);
});

test('two graphs in one realm each answer for their own layers, and one going leaves the other '
    + 'whole', async()=>{
    // A child started beside its parent is a second graph in the same realm,
    // built after the parent's and disposed while the parent goes on. Each
    // layer's diagnostics and dispose belong to the graph that made it: the
    // child's going neither empties the parent's report nor takes away what
    // the parent's own dispose has to release.
    // What a layer reports on, not the values: the clock's wall time moves.
    /** @param {any} core */
    const shape = core=>core.diagnostics().map((/** @type {any} */ layer)=>
        [layer.name, layer.status, Object.keys(layer.metrics ?? {}).sort()]);
    const parent = await assembleModules({ filesystem: { pageFile: await testPageFile() },
        cache: { reader: roomy.reader } });
    const before = shape(parent);
    const child = await assembleModules({ filesystem: { pageFile: await testPageFile() },
        cache: { reader: roomy.reader } });
    child.api('graphics');

    await child.dispose();
    assert.deepEqual(shape(parent), before,
        'the parent\'s report is what it was before the child came and went');
    assert.doesNotThrow(()=>parent.api('graphics').available(),
        'and its layers still answer');

    await parent.dispose();
    assert.throws(()=>parent.api('graphics').available(),
        (/** @type {any} */ error)=>error.code === 'NOT_IMPLEMENTED',
        'the parent\'s own dispose reached the parent\'s instance');
});

test('a build is taken down once however many times it is disposed', async()=>{
    const core = await assembleModules({ filesystem: { pageFile: await testPageFile() },
        cache: { reader: roomy.reader } });
    /** @type {Map<string, number>} */
    const calls = new Map();
    for (const module of core.modules)
    {
        const own = module.dispose.bind(module);
        module.dispose = async()=>{
            calls.set(module.name, (calls.get(module.name) ?? 0) + 1);
            // A teardown that waits, as the cpu layer's waits for its store.
            await new Promise(resolve=>setTimeout(resolve, 1));
            return own();
        };
    }
    await Promise.all([core.dispose(), core.dispose()]);
    await core.dispose();
    assert.deepEqual([...calls.values()].filter(count=>count !== 1), [],
        'each layer is disposed exactly once');
    assert.equal(calls.size, core.modules.length);
});
