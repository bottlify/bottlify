/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Integration test: what the layer publishes about a real machine, on cork.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuModule } from './module.js';
import { createMetrics } from '../log/internal/metrics.js';
import { readTable } from '../log/internal/table.js';

const GUEST_CODE = 0x8000;
const CORK = new URL('../../../../cork/src/index.js', import.meta.url).href;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * The layer over cork, with a guest that runs forever from `at`.
 *
 * @param {Uint8Array} code @param {number} at @param {any} [config]
 */
async function booted(code, at, config = {}){
    const metrics = createMetrics({ shared: false });
    /** @type {string[]} */
    const words = [];
    const moduleHost = /** @type {any} */ ({
        requireApi: ()=>({
            metrics,
            /** @param {string} text */
            intern: text=>{
                const found = words.indexOf(text);
                return found >= 0 ? found : words.push(text) - 1;
            },
        }),
        provide: ()=>{},
    });
    const api = await cpuModule.create({ engine: 'cork', engineUrl: CORK, ...config }, moduleHost);
    await api.boot();
    api.writePhysical(at, code);
    api.writePhysical(0x7000, new Uint8Array(u32(at)));
    const counters = ()=>readTable(metrics.describe().cpu.counters).row(0);
    return { api, metrics, counters };
}

test('under cork the jit counters say -1, not a dead compiler', async()=>{
    // Cork has no emulator compiler: the `jit.*` columns stay in the table
    // (a caller reads the same schema on every engine) but report -1, so a
    // zero is never mistaken for a compiler that compiled nothing.
    const metrics = createMetrics({ shared: false });
    const api = await cpuModule.create({
        engine: 'cork',
        engineUrl: CORK,
    }, /** @type {any} */ ({
        requireApi: ()=>({ metrics, intern: ()=>-1 }), provide: ()=>{},
    }));
    await api.boot();
    api.writePhysical(GUEST_CODE, new Uint8Array([0xf4]));
    api.writePhysical(0x7000, new Uint8Array(u32(GUEST_CODE)));
    api.runSlice(100);
    metrics.sample();
    const row = readTable(metrics.describe().cpu.counters).row(0);
    assert.equal(row['jit.compiledSteps'], -1);
    assert.equal(row['jit.cache'], -1);
    assert.equal(/** @type {any} */ (cpuModule.diagnostics().metrics).jit, -1);
    await cpuModule.dispose();
});

test('a slice that ends before its budget credits no sample to where it stopped', async()=>{
    // mov ecx, 50000; L: dec ecx; jnz L; hlt -- the slice ends early at the hlt,
    // which is where the guest asked to stop, not where it ran.
    const { api } = await booted(new Uint8Array([0xb9, 0x50, 0xc3, 0, 0, 0x49, 0x75, 0xfd, 0xf4]),
        GUEST_CODE);
    // An interpreted slice also ends on time, so the loop may take more than one.
    let retired = 0;
    for (let slice = 0; slice < 1000 && api.eip() !== GUEST_CODE + 9; slice++)
    {
        retired += api.runSlice(10_000_000);
    }
    assert.ok(retired > 50_000 && retired < 10_000_000, `the loop ran and halted: ${retired}`);
    const metrics = /** @type {any} */ (cpuModule.diagnostics().metrics ?? {});
    const halt = metrics.samples.top.find((/** @type {any} */ bucket)=>
        bucket.address <= GUEST_CODE + 8 && GUEST_CODE + 8 < bucket.address + 0x40);
    // The boot's own first slice, which ran its budget, may sit in the bucket.
    assert.ok((halt?.instructions ?? 0) < retired,
        `the hlt is not charged with the loop: ${JSON.stringify(halt)}`);
    api.stop();
    await cpuModule.dispose();
});

test('slices credit the address the guest ran at', async()=>{
    const { api } = await booted(new Uint8Array([0x48, 0xeb, 0xfd]), GUEST_CODE);

    // Only a slice that runs its whole budget is a sample, and an interpreted
    // slice on a loaded machine is cut on time; the first that runs it is.
    let full = false;
    for (let slice = 0; slice < 100 && !full; slice++)
    {
        full = api.runSlice(4096) === 4096;
    }
    assert.ok(full, 'a slice ran its whole budget');
    // `diagnostics()` is the module's, not the instance's -- read through the
    // same door a real caller does.
    const status = cpuModule.diagnostics();
    assert.equal(status.status, 'ready');
    const metrics = /** @type {any} */ (status.metrics ?? {});
    assert.ok(metrics.samples.slices > 0, 'the slice that ran was credited');
    assert.ok(metrics.samples.top.length > 0);
    const [top] = metrics.samples.top;
    assert.ok(top.address >= GUEST_CODE - 0x40 && top.address < GUEST_CODE + 3,
        `the heaviest bucket is at 0x${top.address.toString(16)}, not the guest's loop`);
    assert.ok(top.instructions > 0);
    // No clock per slice: the sampler credits instructions only, and a reader
    // derives milliseconds from the guest phase.
    assert.equal(top.ms, undefined);

    api.stop();
    await cpuModule.dispose();
});

test('sampling: false leaves every slice uncredited', async()=>{
    const { api } = await booted(
        new Uint8Array([0x48, 0xeb, 0xfd]), GUEST_CODE, { sampling: false });

    api.runSlice(4096);
    const status = cpuModule.diagnostics();
    const metrics = /** @type {any} */ (status.metrics ?? {});
    assert.equal(metrics.samples.slices, 0);
    assert.deepEqual(metrics.samples.top, []);

    api.stop();
    await cpuModule.dispose();
});

test('a second instance in one realm boots on its own, never seeing the first one\'s machine',
    async()=>{
        const { api: first } = await booted(new Uint8Array([0x48, 0xeb, 0xfd]), GUEST_CODE);

        const metrics = createMetrics({ shared: false });
        const second = await cpuModule.create({ engine: 'cork', engineUrl: CORK },
            /** @type {any} */ ({
                requireApi: ()=>({ metrics, intern: ()=>-1 }),
                provide: ()=>{},
            }));
        // The check reads this instance's own host, not the module's, which
        // the first instance has already set.
        await second.boot();
        assert.equal(second.booted(), true);
        assert.equal(first.booted(), true, 'and the first instance is unaffected');

        second.stop();
        first.stop();
        await cpuModule.dispose();
    });

test('a disposed cpu answers as a never-booted one does, after a real boot', async()=>{
    const { api } = await booted(new Uint8Array([0x48, 0xeb, 0xfd]), GUEST_CODE);
    assert.equal(api.booted(), true);

    await cpuModule.dispose();

    assert.equal(api.booted(), false);
    assert.equal(api.fault(), null);
    assert.throws(()=>api.readPhysical(0, 4),
        /cpu: boot\(\) must be called before the guest can run/);
    assert.throws(()=>api.runSlice(1),
        /cpu: boot\(\) must be called before the guest can run/);
});
