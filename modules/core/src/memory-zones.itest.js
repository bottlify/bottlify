/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A run's report sums what its layers hold of the tab's memory by zone
 * (`memory-zones.js`): the guest's by what the program took, not by its RAM,
 * and a pool nothing measured said so rather than counted as nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { MEMORY_ZONES, NOT_MEASURED, TAB_MEMORY_LIMIT } from './memory-zones.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

test('a run given two gigabytes of RAM holds what its program took, and the report sums the zones',
    { timeout: 60000 }, async t=>{
        // mov ecx, 1000000; L: inc eax; dec ecx; jnz L; push 0; call [ExitProcess]
        const loop = [0xb9, ...u32(1_000_000), 0x40, 0x49, 0x75, 0xfc];
        const executable = buildExe({
            imports: { 'KERNEL32.dll': ['ExitProcess'] },
            codeSize: 0x20,
            code: ({ iat })=>[...loop, 0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))],
        });
        const app = await createApp({ executable, engine: 'cork',
            memorySize: 2 * 1024 * 1024 * 1024 });
        t.after(()=>app.dispose());
        assert.equal(await app.run(), 0);

        const report = await app.report();
        /** @param {string} name */
        const table = name=>report.diagnostics.find((/** @type {{ name: string }} */ one)=>
            one.name === name);
        const zones = table('zones');
        assert.ok(zones, 'the zones\' sums are in the report');
        assert.equal(report.diagnostics.at(-1).name, 'zones', 'last, over every other table');
        const { guest, translation, heaps } = zones.metrics.zones;
        // The image, its stacks and a few heap blocks: megabytes of the RAM's
        // two gigabytes, every pool measured.
        assert.deepEqual(guest.notMeasured, []);
        assert.ok(guest.pools['app.images'] >= 0x1000, `image ${guest.pools['app.images']}`);
        assert.ok(guest.pools['app.mainStack'] >= 0x10000);
        assert.ok(guest.pools['app.heap'] > 0, 'the runtime\'s own blocks');
        assert.equal(typeof guest.pools['kernel.stacks'], 'number');
        assert.ok(guest.bytes < 64 * 1024 * 1024, `guest ${guest.bytes}`);
        assert.ok(guest.bytes <= MEMORY_ZONES.guest);
        assert.ok(translation.pools['cpu.tables'] > 0, 'the engine\'s tables are measured');
        const modules = translation.pools['cpu.modules'];
        assert.ok(modules > 0 || translation.notMeasured.includes('cpu.modules'),
            `the translator's modules are measured or said not to be, never nothing: ${modules}`);
        assert.ok(heaps.notMeasured.includes('graphics.engine'));
        assert.ok(zones.metrics.total <= TAB_MEMORY_LIMIT);
        assert.equal(typeof NOT_MEASURED, 'string');
    });
