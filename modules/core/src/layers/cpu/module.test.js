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

/** A cpu instance with no log registry, for tests that never boot the emulator. */
async function open(){
    return cpuModule.create({}, /** @type {any} */ ({
        requireApi: ()=>({}),
        provide: ()=>{},
    }));
}

test('a second instance in one realm does not take the first one\'s state', async()=>{
    // Booting a real emulator is an integration concern (module.itest.js has
    // the prebuilt-artifact test for `boot()` itself); this pins the same
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
        'every method that needs a running emulator answers as a never-booted instance does');
    assert.throws(()=>api.runSlice(1),
        /cpu: boot\(\) must be called before the guest can run/);
    assert.throws(()=>api.readPhysical(0, 4),
        /cpu: boot\(\) must be called before the guest can run/);
});

test('the cpu layer reports its engine before boot and after', async()=>{
    await cpuModule.create({}, /** @type {any} */ ({
        requireApi: ()=>({}), provide: ()=>{},
    }));
    assert.equal(cpuModule.diagnostics().metrics?.engine, 'cork', 'before boot');
    await cpuModule.dispose();

    await open();
    assert.equal(cpuModule.diagnostics().metrics?.engine, 'cork', 'once open');
    await cpuModule.dispose();
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
    const context = { eip: 0, inHlt: 1, reg32: new Int32Array(8), flags: 0x8d7, flagsChanged: 1 };

    api.resumeContextAt(context, { eip: 0x401000, returnValue: 0, registers: { eflags: 0x202 } });

    assert.equal(context.flags, 0x202);
    assert.equal(context.flagsChanged, 0, 'the word is literal, nothing lazy recomputes over it');
    assert.deepEqual([...context.reg32], [0, 0, 0, 0, 0, 0, 0, 0], 'and it is no register');
    await cpuModule.dispose();
});
