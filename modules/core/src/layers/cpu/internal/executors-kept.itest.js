/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's cache as the store of a process's emitted functions, across
 * threads: the process's own executor keeps what it emits there (it writes the
 * run's cache), another executor in a worker reads the same names in place
 * and sends what it emits to the process to keep; a relink on either takes
 * the functions kept before rather than emitting them again. The programs
 * leave what they leave run alone, with no store of functions at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from './cork-host.js';
import { createBell, createRemoteExecutor } from './executor.js';
import { KEPT_OPTIONS, KEPT_SPACE, STORE_SPACE } from './store-relay.js';
import { testCache } from '../../cache/testing.fixture.js';
import * as engine from '../../../../../cork/src/index.js';

const ENGINE_URL = new URL('../../../../../cork/src/index.js', import.meta.url).href;
const MEMORY = 4 << 20;
const FUNCTIONS = 0x50000;
const DRIVERS = [0x40000, 0x48000];
const DATA = [0x30000, 0x31000];
const STACKS = [0x300000, 0x2f0000];
const TRAP_PORT = 0xb077;
/** One region a module, relinked soon: a relink emits running regions again into one module. */
const CORK = { hotThreshold: 4, wasmInterpreter: true, sliceMs: Infinity, leafBytes: 1,
    batchRegions: 1, maxBatchRegions: 1, relinkAfter: 2, relinkQuiet: 0, bundleId: 'test' };
const CONFIG = { memorySize: MEMORY, trapPort: TRAP_PORT, entryVector: 0x7000,
    initialStack: STACKS[0], closedBelow: 0x10000, executors: 2 };

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {number} at @param {number} target */
const call = (at, target)=>[0xe8, ...u32(target - (at + 5))];
const settle = ()=>new Promise(resolve=>setTimeout(resolve, 0));

/**
 * Functions both drivers call, each driver a loop over all of them.
 * f_i: add eax, k; xor ebx, eax; add [ebp + 4 i], eax; ret
 */
function programs(){
    const count = 12;
    const functions = Array.from({ length: count }, (_, i)=>({ at: FUNCTIONS + i * 0x40,
        code: [0x05, ...u32(i * 7919 + 3), 0x31, 0xc3, 0x01, 0x45, i * 4, 0xc3] }));
    const drivers = DRIVERS.map((at, which)=>{
        const code = [0xb9, ...u32(60_000 + which * 1000)];
        for (const one of which === 0 ? functions : [...functions].reverse())
        {
            code.push(...call(at + code.length, one.at));
        }
        code.push(0x49, 0x0f, 0x85, ...u32(5 - (code.length + 7)), 0xf4);
        return { at, code, eax: 1 + which, ebx: 2 + which };
    });
    return { count, functions, drivers };
}

/** One program alone on one executor, no store of functions: what it leaves.
 * @param {ReturnType<typeof programs>} made @param {number} which */
async function alone(made, which){
    const host = createCorkHost({ ...CONFIG, executors: 1, engine, cork: CORK });
    host.onTrap(()=>{});
    for (const { at, code } of [...made.functions, made.drivers[which]])
    {
        host.writePhysical(at, new Uint8Array(code));
    }
    const { at, eax, ebx } = made.drivers[which];
    host.writeReg32('eax', eax);
    host.writeReg32('ebx', ebx);
    host.writeReg32('ebp', DATA[which]);
    host.writeReg32('esp', STACKS[which]);
    host.writeReg32('eip', at);
    for (let turn = 0; turn < 100_000 && !host.halted(); turn++)
    {
        host.runSlice(1000);
        await host.cork().translatePending();
    }
    assert.ok(host.halted());
    return [host.readReg32('eax') >>> 0, host.readReg32('ebx') >>> 0,
        ...host.readPhysical(DATA[which], made.count * 4)];
}

test('two executors keep their functions in the run\'s cache, the worker\'s sent to the process,'
    + ' and a relink takes them there; each program leaves what it leaves alone', async()=>{
    const made = programs();
    const expected = [await alone(made, 0), await alone(made, 1)];
    const cache = await testCache({ coldAfterMs: 1000 });
    const kept = { space: cache.space(KEPT_SPACE, KEPT_OPTIONS), prefix: `${KEPT_SPACE}/`,
        join: cache.join };
    const process = createCorkHost({ ...CONFIG, engine, cork: { ...CORK, kept } });
    process.onTrap(()=>{});
    // The worker's configuration is data: the store stays here, as the cpu layer leaves it.
    const remote = await createRemoteExecutor({ host: process, index: 1, engineUrl: ENGINE_URL,
        config: { ...CONFIG, cork: CORK }, bell: createBell(),
        cache: { join: cache.join, space: cache.space(STORE_SPACE) } });
    try
    {
        for (const { at, code } of [...made.functions, ...made.drivers])
        {
            process.writePhysical(at, new Uint8Array(code));
        }
        /** @param {number} which */
        const begin = which=>{
            const { at, eax, ebx } = made.drivers[which];
            process.writeReg32('eax', eax);
            process.writeReg32('ebx', ebx);
            process.writeReg32('ebp', DATA[which]);
            process.writeReg32('esp', STACKS[which]);
            process.writeReg32('eip', at);
        };
        remote.onBlock(()=>begin(1));
        remote.start(1000);
        begin(0);
        let own = false;
        let other = false;
        const started = Date.now();
        while (!(own && other) && Date.now() - started < 600_000)
        {
            if (!own)
            {
                process.runSlice(1000);
                process.cork().translatePending().catch(()=>{});
                own = process.halted();
            }
            if (!other)
            {
                const ended = remote.step();
                if (ended !== null)
                {
                    assert.equal(ended.fault, null);
                    other = ended.halted;
                    if (!other)
                    {
                        remote.start(1000);
                    }
                }
            }
            await settle();
        }
        assert.ok(own && other, 'both ran to the end');
        const view = new DataView(remote.block().buffer, remote.block().byteOffset);
        const layout = process.blockLayout();
        const states = [
            [process.readReg32('eax') >>> 0, process.readReg32('ebx') >>> 0,
                ...process.readPhysical(DATA[0], made.count * 4)],
            [view.getUint32(layout.regs, true), view.getUint32(layout.regs + 3 * 4, true),
                ...process.readPhysical(DATA[1], made.count * 4)],
        ];
        assert.deepEqual(states, expected, 'the same registers and memory as alone');
        /** @type {any[]} */
        const figures = [process.cork().diagnostics(), await remote.diagnostics()];
        const held = /** @type {any} */ (cache.keeper).under(`${KEPT_SPACE}/`);
        assert.ok(held.bodies > 0, `${held.bodies} functions kept in the run's cache`);
        assert.ok(figures[0].kept, 'the process\'s translator keeps there');
        assert.ok(figures[1]?.kept, 'and the worker\'s');
        assert.ok(figures[0].kept.hits > 0, `the process took ${figures[0].kept.hits} back`);
        assert.ok(figures[1].kept.hits > 0, `the worker took ${figures[1].kept.hits} back`);
        // Functions only the worker emitted, in the shared layout, came to the
        // run's cache through the process: more are there than the process kept.
        assert.ok(figures[0].relinked > 0 && figures[1].relinked > 0, 'both relinked');
    }
    finally
    {
        await remote.close();
    }
});
