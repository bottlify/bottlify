/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CPU_COUNTERS, cpuModule } from './module.js';
import { createMetrics } from '../log/internal/metrics.js';
import { readTable } from '../log/internal/table.js';

test('the cpu registers its counters with the log layer and samples them once a frame',
    async()=>{
        const metrics = createMetrics({ shared: false });
        await cpuModule.create({}, /** @type {any} */ ({
            requireApi: ()=>({ metrics, intern: ()=>-1 }),
            provide: ()=>{},
        }));
        const table = metrics.describe().cpu.counters;
        assert.deepEqual(table.columns, CPU_COUNTERS);
        assert.ok(CPU_COUNTERS.includes('instructions'));
        assert.ok(CPU_COUNTERS.includes('jit.compiledSteps'));

        // Before boot there is no emulator to read; a frame closing then must
        // not throw and must leave the row as it was.
        metrics.sample();
        assert.equal(readTable(table).row(0).instructions, 0);
        await cpuModule.dispose();
    });

test('a build without a log registry still creates', async()=>{
    const api = await cpuModule.create({}, /** @type {any} */ ({
        requireApi: ()=>({}),
        provide: ()=>{},
    }));
    assert.equal(typeof api.boot, 'function');
    assert.equal(cpuModule.diagnostics().status, 'created');
    await cpuModule.dispose();
});
