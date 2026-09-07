/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logModule } from './module.js';

/** @param {any} [config] */
async function open(config){
    let time = 0;
    const api = await logModule.create({ now: ()=>time, ...config });
    return { api, at: (/** @type {number} */ to)=>{ time = to; return api; } };
}

test('the module keeps the contract it is registered under', ()=>{
    assert.equal(logModule.name, 'log');
    assert.deepEqual(logModule.requires, [], 'this layer depends on nothing');
    assert.equal(typeof logModule.diagnostics, 'function');
    assert.deepEqual(logModule.diagnostics().status, 'created');
});

test('configuration is data: levels by name, categories, sinks', async()=>{
    /** @type {any[]} */
    const seen = [];
    const { api } = await open({
        level: 'warn',
        categories: { cpu: 'trace' },
        sinks: [(/** @type {any[]} */ records)=>seen.push(...records)],
    });

    api.info('loader', 'too quiet for the default level');
    api.trace('cpu', 'kept: this category asked for everything');
    api.error('loader', 'kept: {0} is loud enough', 'error');
    api.flush();

    assert.deepEqual(seen.map(record=>record.text),
        ['kept: this category asked for everything', 'kept: error is loud enough']);
    assert.equal(api.levelOf('cpu'), api.Level.TRACE);

    await logModule.dispose();
});

test('a build with no clock says so instead of reporting plausible zeroes', async()=>{
    await logModule.create({});

    const diagnostics = logModule.diagnostics();
    assert.equal(diagnostics.status, 'ready');
    assert.deepEqual(diagnostics.issues, ['No clock was configured: timestamps and durations '
        + 'are all zero.']);

    await logModule.dispose();
});

test('diagnostics carry the share the thresholds watch', async()=>{
    const { api, at } = await open({});

    at(0).beginFrame();
    at(0).begin('present', api.PhaseKind.HOST);
    at(2).begin('run', api.PhaseKind.GUEST);
    at(18).end('run');
    at(20).end('present');
    at(100).endFrame();

    const metrics = logModule.diagnostics().metrics ?? {};
    assert.equal(metrics.frames, 1);
    assert.equal(metrics.hostShare, 0.04, 'four of a hundred milliseconds were ours');
    assert.equal(metrics.journal.capacity, 4096);
    assert.ok(metrics.topPhases[0].startsWith('run guest x1'));

    await logModule.dispose();
    assert.equal(logModule.diagnostics().status, 'created');
});
