/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of host calls run as steps (`bridge.drive`): a second path beside
 * the promise one, which parks the thread for each guest call and resumes it
 * a turn of the run loop later. The steps call the guest in the slice the
 * call came in.
 *
 * The program is `test/fixtures/effect.exe`, a D3DX effect driven the way a
 * renderer drives one -- two passes a frame, parameters changed between
 * draws, CommitChanges after each change and sometimes again with nothing
 * changed, Begin with its state saved and restored or not -- through an
 * ID3DXEffectStateManager of its own, which records every state it is handed
 * and passes it on to the device, and then with no manager at all. After
 * each frame it reads back what the device holds. Its seed is the last number
 * on its command line. Every seed is run down both paths, and everything the
 * program can observe -- what its manager was handed, every HRESULT, what the
 * device holds, its exit code -- must be the same; the steps' path must
 * besides have made its guest calls without the turns. A thread of the
 * program's keeps busy beside the renderer, and the steps run a third time on
 * two executors, where a call may be answered for the one that is not the
 * process's own: whether one of the effect's was is not measured here, only
 * that the executors' slices ran.
 *
 * `EFFECT_SEEDS` raises the count of seeds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';

const SEEDS = Number(process.env.EFFECT_SEEDS ?? 6);

/**
 * One run of the program: what it printed, its exit code, the run loop's
 * turns, its guest calls and the slices other executors ran.
 *
 * @param {Uint8Array} executable @param {number} seed @param {boolean} drive
 * @param {number} [executors]
 */
async function run(executable, seed, drive, executors = 1){
    const gpu = createFakeDevice();
    const app = await createApp({
        executable,
        imagePath: 'C:\\App\\effect.exe',
        commandLine: `effect.exe ${seed}`,
        driveGuestCalls: drive,
        // Every executor open from the first instruction: opened as threads
        // want them, a run this short is over before the second one is.
        ...(executors > 1 ? { cpu: { cores: executors, eager: true } } : {}),
        device: {
            device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
            adapter: { vendor: 'fake', architecture: '', description: 'a stand-in' },
        },
    });
    let printed = '';
    app.on('output', (/** @type {any} */ event)=>{
        printed += event?.text ?? '';
    });
    try
    {
        const code = await app.run({ timeoutMs: 60000 });
        const tables = app.diagnostics();
        /** @param {string} name */
        const metrics = name=>tables.find((/** @type {any} */ layer)=>layer.name === name)
            ?.metrics;
        return { code, printed, turns: metrics('kernel')?.turns ?? 0,
            callbacks: metrics('bridge')?.callbacks ?? 0,
            executorSlices: metrics('kernel')?.executorSlices ?? 0 };
    }
    finally
    {
        await app.dispose();
    }
}

test('an effect\'s passes set through the program\'s state manager as steps leave what they leave'
    + ' through promises, without a turn for each guest call', { timeout: 300000 }, async()=>{
    const executable = await readFile(new URL('../test/fixtures/effect.exe', import.meta.url));
    let stepsTurns = 0;
    let promiseTurns = 0;
    let executorSlices = 0;
    for (let seed = 1; seed <= SEEDS; seed++)
    {
        const steps = await run(executable, seed, true);
        const promises = await run(executable, seed, false);
        const shared = await run(executable, seed, true, 2);
        assert.match(promises.printed, /^hash 0x[0-9a-f]{8}/m, `seed ${seed} printed its hash`);
        assert.doesNotMatch(promises.printed, /FAIL/, `seed ${seed}: ${promises.printed}`);
        assert.equal(steps.printed, promises.printed, `seed ${seed}`);
        assert.equal(steps.code, promises.code, `seed ${seed}`);
        assert.equal(steps.callbacks, promises.callbacks, `seed ${seed}: the same guest calls`);
        assert.equal(shared.printed, promises.printed, `seed ${seed} on two executors`);
        assert.equal(shared.code, promises.code, `seed ${seed} on two executors`);
        executorSlices += shared.executorSlices;
        stepsTurns += steps.turns;
        promiseTurns += promises.turns;
    }
    console.log(`effect steps: ${SEEDS} seeds, ${stepsTurns} turns as steps,`
        + ` ${promiseTurns} through promises, ${executorSlices} slices on another executor`);
    // The steps' path ran: its guest calls took no turns of their own.
    assert.ok(stepsTurns * 10 < promiseTurns,
        `${stepsTurns} turns as steps against ${promiseTurns} through promises`);
    assert.ok(executorSlices > 0, 'no slice ran on another executor');
});
