/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomy } from '../cache/testing.fixture.js';
import { CPU_COUNTERS, cpuModule } from './module.js';
import { openTable } from '@bottlify/cellar';
import { testLog } from '../log/testing.fixture.js';

test('the cpu registers its counters with the log layer and samples them once a frame',
    async()=>{
        const log = await testLog();
        const metrics = log.metrics;
        await cpuModule.create({}, /** @type {any} */ ({
            requireApi: (/** @type {string} */ name)=>(name === 'cache' ? roomy.api : log),
            provide: ()=>{},
        }));
        const table = metrics.describe().cpu.counters;
        assert.deepEqual(table.columns, CPU_COUNTERS);
        assert.ok(CPU_COUNTERS.includes('instructions'));

        // Before boot there is no machine to read; a frame closing then must
        // not throw and must leave the row as it was.
        metrics.sample();
        assert.equal(openTable(table).row(0).instructions, 0);
        await cpuModule.dispose();
    });

/** A cpu instance over a log of its own, for tests that never boot the machine. */
async function open(){
    const log = await testLog();
    return cpuModule.create({}, /** @type {any} */ ({
        requireApi: (/** @type {string} */ name)=>(name === 'cache' ? roomy.api : log),
        provide: ()=>{},
    }));
}

test('a second instance in one realm does not take the first one\'s state', async()=>{
    // Booting a real machine is an integration concern (module.itest.js has
    // the tests of `boot()` itself); this pins the same
    // class of bug on the state a fresh, unbooted instance already owns --
    // the fault record -- which used to live at module scope alongside `host`.
    const first = await open();
    first.raiseFault({ name: 'first-fault', detail: 'x', eip: 0x1000 });

    const second = await open();

    assert.ok(first.fault(), 'the first instance keeps its own fault');
    assert.equal(first.fault().name, 'first-fault');
    assert.equal(second.fault(), null, 'and the second starts with none of its own');

    await cpuModule.dispose();
});

test('a disposed cpu answers harmlessly rather than throwing', async()=>{
    const api = await open();
    api.raiseFault({ name: 'x', detail: 'y', eip: 0x1000 });

    await cpuModule.dispose();

    assert.equal(api.booted(), false);
    assert.equal(api.fault(), null);
    api.raiseFault({ name: 'late', detail: 'z', eip: 0x2000 });
    assert.equal(api.fault(), null, 'raiseFault is a no-op once disposed');
    api.stop();
    assert.throws(()=>api.run(), /cpu: boot\(\) must be called before the guest can run/,
        'every method that needs a running machine answers as a never-booted instance does');
    assert.throws(()=>api.runSlice(1),
        /cpu: boot\(\) must be called before the guest can run/);
    assert.throws(()=>api.readPhysical(0, 4),
        /cpu: boot\(\) must be called before the guest can run/);
});

test('diagnostics answers for the live instance', async()=>{
    await open();
    const second = await open();
    second.raiseFault({ name: 'second-only', detail: 'x', eip: 0x1000 });

    assert.equal(cpuModule.diagnostics().status, 'created',
        'unbooted either way, but the second (most recently created) instance is the one asked');
    assert.equal(second.fault().name, 'second-only');

    await cpuModule.dispose();
});

test('a resume can carry the registers the code it enters reads first', async()=>{
    // An exception handler's block addresses its function's locals through EBP
    // from its first instruction; ESP and EAX keep their own rules.
    const api = await open();
    const context = { eip: 0, inHlt: 1, reg32: new Int32Array(8) };

    api.resumeContextAt(context, {
        eip: 0x401000, returnValue: 7, esp: 0x2ff000,
        registers: { ebp: 0x2ff100, ebx: 0x11, esi: 0x22, edi: 0x33, esp: 0x1, unknown: 9 },
    });

    assert.equal(context.eip, 0x401000);
    assert.deepEqual([...context.reg32], [7, 0, 0, 0x11, 0x2ff000, 0x2ff100, 0x22, 0x33],
        'EAX from the return value, ESP from its own argument, the rest from the set given');
    assert.equal(context.inHlt, 0);
    await cpuModule.dispose();
});

test('a resume can carry the flags word the code it enters starts with', async()=>{
    // An exception handler starts with DF clear whatever the faulting code
    // had, and the context it continues from gives the flags back.
    const api = await open();
    const block = new Uint8Array(512);
    const view = new DataView(block.buffer);
    view.setUint32(40, 0x8d7, true);
    view.setUint32(44, 3, true); // the record of a region's last arithmetic
    const context = { block, layout: { bits: 32, regs: 0, eflags: 40, flagRecord: 44 }, eip: 0,
        inHlt: 1, reg32: new Int32Array(8) };

    api.resumeContextAt(context, { eip: 0x401000, returnValue: 0, registers: { eflags: 0x202 } });

    assert.equal(view.getUint32(40, true), 0x202);
    assert.equal(view.getUint32(44, true), 0, 'the word is whole, no record folds over it');
    assert.deepEqual([...context.reg32], [0, 0, 0, 0, 0, 0, 0, 0], 'and it is no register');
    await cpuModule.dispose();
});
