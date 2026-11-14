/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The guest's own clock (`clock: 'virtual'`): a program run on it translates
 * and runs the same code however the machine's clock goes, so what it did --
 * the instructions, the ways between its regions, the regions and their bytes
 * -- is the same to the unit on a quiet machine and on one whose clock jumps
 * as a loaded one's does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCorkHost } from './cork-host.js';
import * as engine from '../../../../../cork/src/index.js';

const IMAGES = new URL('../../../../../cork/bench/micro/images/', import.meta.url);
const IMAGE_BASE = 0x401000;
const ENTRY_VECTOR = 0x7000;

/**
 * A micro workload's iterations on a cork host, the translator fed between slices
 * as a frame feeds it, and what they did. The wasm interpreter tier from the
 * first instruction: a host made before the process's tier started runs a
 * first stretch on the JavaScript interpreter, one made after it does not, and
 * the two then leave their callees otherwise -- the process's state, not time.
 *
 * @param {string} name @param {'host' | 'virtual'} clock @param {number} iterations
 */
async function runOf(name, clock, iterations){
    const host = createCorkHost({
        engine, memorySize: 16 << 20, trapPort: 0xb077, entryVector: ENTRY_VECTOR,
        initialStack: 0x800000,
        // The default slice, 8 ms: on the machine's clock it is what the clock decides.
        cork: { blockProfile: true, clock, wasmInterpreterAfter: 0, sliceMs: 8 },
    });
    host.writePhysical(IMAGE_BASE, readFileSync(new URL(`${name}.bin`, IMAGES)));
    const vector = new Uint8Array(4);
    new DataView(vector.buffer).setUint32(0, IMAGE_BASE, true);
    host.writePhysical(ENTRY_VECTOR, vector);
    let retired = 0;
    for (let i = 0; i < iterations; i++)
    {
        retired += host.runSlice(100_000);
        while (!host.halted())
        {
            await host.cork().translatePending();
            retired += host.runSlice(100_000);
        }
    }
    const d = /** @type {any} */ (host.cork().diagnostics());
    return { retired, eax: host.readReg32('eax'), mechanisms: d.mechanisms, regions: d.regions,
        heldBytes: d.heldBytes };
}

/**
 * `run` with the machine's clock made by the test, so no reading of the real one
 * decides anything: `noisy` jumps as a loaded machine's does (3 ms between two
 * readings, every seventh 300), a quiet one stands still.
 *
 * @template T @param {boolean} noisy @param {() => Promise<T>} run @returns {Promise<T>}
 */
async function underClock(noisy, run){
    const real = performance.now;
    let at = 0;
    let reads = 0;
    performance.now = ()=>{
        reads++;
        at += !noisy ? 0 : reads % 7 === 0 ? 300 : 3;
        return at;
    };
    try
    {
        return await run();
    }
    finally
    {
        performance.now = real;
    }
}

test('on the guest\'s clock a program runs the same to the unit however the machine\'s clock'
    + ' goes; on the machine\'s it does not', async()=>{
    for (const name of ['vcall-x87', 'calls512-scatter-x87'])
    {
        const quiet = await underClock(false, ()=>runOf(name, 'virtual', 6));
        const noisy = await underClock(true, ()=>runOf(name, 'virtual', 6));
        assert.deepEqual(noisy, quiet, `${name}: the same work, the same code`);
        assert.ok(quiet.retired > 0 && quiet.mechanisms.TRANSFER >= 0);
    }
    // The machine's clock decides a slice's length and so when the translator is
    // fed: the same noise moves what the program did.
    const quiet = await underClock(false, ()=>runOf('vcall-x87', 'host', 6));
    const noisy = await underClock(true, ()=>runOf('vcall-x87', 'host', 6));
    assert.equal(noisy.eax, quiet.eax, 'the program\'s answer is its own either way');
    assert.notDeepEqual(noisy.mechanisms, quiet.mechanisms,
        'on the machine\'s clock the noise is seen in the counts');
});
