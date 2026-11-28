/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The eviction gate for a process of several executors (a second path beside
 * a runtime that holds every module it made). Each executor's runtime
 * translates the program's code for itself and, under a ceiling on what it
 * holds (`cacheBytes`), lets modules go and brings them back from the run's
 * store; what the executors share is the guest's memory and its page flags.
 *
 * - Two seeded programs run at once, one on the process's own executor and
 *   one on another in a worker, calling the same functions, each under a
 *   ceiling a few modules high: each leaves the registers and memory it
 *   leaves alone on one executor with no ceiling.
 * - One executor lets go of its code on a page where the other still has a
 *   region, and the other then stores into that region's code: it runs the
 *   code as written, so the page stayed marked for it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from './cork-host.js';
import { createBell, createRemoteExecutor } from './executor.js';
import * as engine from '../../../../../cork/src/index.js';
import { testAccount, testAccountCalls } from '../testing.fixture.js';

const ENGINE_URL = new URL('../../../../../cork/src/index.js', import.meta.url).href;
const MEMORY = 4 << 20;
const FUNCTIONS = 0x50000;
/** A function of the other executor's alone, on the page of the ones both call. */
const OWN = FUNCTIONS + 0x800;
/** Each program's driver, its data and its stack, by executor. */
const DRIVERS = [0x40000, 0x48000];
const DATA = [0x30000, 0x31000];
const STACKS = [0x300000, 0x2f0000];
const FLAG = 0x32000;
const TRAP_PORT = 0xb077;
/** One region a module, no callee formed into its caller: every call crosses modules. */
const CORK = { hotThreshold: 4, wasmInterpreter: true, sliceMs: Infinity, leafBytes: 1,
    batchRegions: 1, maxBatchRegions: 1, relinkAfter: 0, bundleId: 'test' };
const CONFIG = {
    memoryBudget: testAccount(), memorySize: MEMORY, trapPort: TRAP_PORT, entryVector: 0x7000,
    initialStack: STACKS[0], closedBelow: 0x10000, executors: 2 };

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** A seeded generator. @param {number} seed */
function random(seed){
    let s = seed >>> 0;
    return (/** @type {number} */ n)=>{
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        return (s >>> 8) % n;
    };
}

/** A turn of the event loop. */
const settle = ()=>new Promise(resolve=>setTimeout(resolve, 0));

/** @param {number} at  where the call is @param {number} target */
const call = (at, target)=>[0xe8, ...u32(target - (at + 5))];

/**
 * @typedef {{ at: number, code: number[] }} Code
 * @typedef {Code & { eax: number, ebx: number }} Driver
 */

/**
 * The functions both programs call and each one's driver.
 * f_i: add eax, k; xor ebx, eax; add [ebp + 4 i], eax; ret
 * driver: mov ecx, rounds; L: call f_s0; ...; dec ecx; jnz L; hlt
 *
 * @param {number} seed
 */
function programs(seed){
    const next = random(seed);
    const count = 10 + next(6);
    /** @type {Code[]} */
    const functions = Array.from({ length: count }, (_, i)=>({ at: FUNCTIONS + i * 0x40,
        code: [0x05, ...u32(next(1 << 30) * 4 + next(4)), 0x31, 0xc3, 0x01, 0x45, i * 4, 0xc3] }));
    /** @type {Driver[]} */
    const drivers = DRIVERS.map(at=>{
        const code = [0xb9, ...u32(100_000 + next(50_000))];
        // Every function, in an order of its own, and a few of them again.
        const order = functions.map(one=>one.at);
        for (let i = order.length - 1; i > 0; i--)
        {
            const j = next(i + 1);
            [order[i], order[j]] = [order[j], order[i]];
        }
        for (const target of [...order, ...order.slice(0, next(5))])
        {
            code.push(...call(at + code.length, target));
        }
        code.push(0x49, 0x0f, 0x85, ...u32(5 - (code.length + 7)), 0xf4);
        return { at, code, eax: next(1 << 30), ebx: next(1 << 30) };
    });
    return { count, functions, drivers };
}

/** A store both runtimes keep their regions in, as a run's is. */
function memoryStore(){
    /** @type {Map<string, Uint8Array>} */
    const records = new Map();
    return {
        get: async(/** @type {string} */ key)=>records.get(key) ?? null,
        put: async(/** @type {string} */ key, /** @type {Uint8Array} */ bytes)=>{
            records.set(key, bytes);
        },
    };
}

/**
 * A process of two executors with the programs' code in its memory, both run
 * at once until each has halted: the first driver on the process's own
 * executor, the second on the other.
 *
 * @param {Code[]} code  what else is in memory
 * @param {Driver[]} drivers  by executor
 * @param {number[]} ceilings  each runtime's `cacheBytes`, 0 for none
 * @param {(process: any) => void} [between]  called once the process's own has halted
 */
async function together(code, drivers, ceilings, between){
    const store = memoryStore();
    const process = createCorkHost({ ...CONFIG, engine,
        cork: { ...CORK, cacheBytes: ceilings[0], store } });
    process.onTrap(()=>{});
    /** @type {any[]} */
    const faults = [];
    process.onFault((/** @type {any} */ fault)=>{
        faults.push(fault);
        return false;
    });
    const remote = await createRemoteExecutor({ account: testAccountCalls,
        host: process, index: 1, engineUrl: ENGINE_URL,
        config: { ...CONFIG, cork: { ...CORK, cacheBytes: ceilings[1] } }, store,
        bell: createBell() });
    try
    {
        for (const { at, code: bytes } of [...code, ...drivers])
        {
            process.writePhysical(at, new Uint8Array(bytes));
        }
        /** @param {number} which */
        const begin = which=>{
            const { at, eax, ebx } = drivers[which];
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
                // Its translator's step, as the app gives it one between slices.
                process.cork().translatePending().catch(()=>{});
                own = process.halted();
                if (own)
                {
                    between?.(process);
                }
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
            // The translators' answers and the store's cross between slices.
            await settle();
        }
        assert.deepEqual(faults, []);
        assert.ok(own && other, 'both ran to the end');
        const view = new DataView(remote.block().buffer, remote.block().byteOffset);
        const layout = process.blockLayout();
        const names = ['eax', 'ecx', 'edx', 'ebx'];
        return {
            process,
            regs: [(/** @type {number} */ index)=>process.readReg32(names[index]) >>> 0,
                (/** @type {number} */ index)=>view.getUint32(layout.regs + index * 4, true)],
            figures: [process.cork().diagnostics(), await remote.diagnostics()],
        };
    }
    finally
    {
        await remote.close();
    }
}

/**
 * One program alone on one executor, no ceiling: what it leaves.
 *
 * @param {ReturnType<typeof programs>} made @param {number} which
 */
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

/**
 * Room for five modules of the size they are on average.
 * @param {{ heldBytes: number, heldModules: number }} figures
 */
const fiveModules = figures=>Math.ceil(5 * figures.heldBytes / figures.heldModules);

for (const seed of [71, 73])
{
    test(`two executors, each letting modules go under its ceiling while the other runs the same`
        + ` functions, leave what each program leaves alone (seed ${seed})`, async()=>{
        const made = programs(seed);
        const expected = [await alone(made, 0), await alone(made, 1)];
        /** @param {Awaited<ReturnType<typeof together>>} run */
        const states = run=>run.regs.map((reg, which)=>[reg(0), reg(3),
            ...run.process.readPhysical(DATA[which], made.count * 4)]);
        const free = await together(made.functions, made.drivers, [0, 0]);
        assert.deepEqual(states(free), expected, 'no ceiling: as alone');
        assert.deepEqual(free.figures.map(one=>one?.evictions), [0, 0]);
        const cacheBytes = fiveModules(free.figures[0]);
        const held = await together(made.functions, made.drivers, [cacheBytes, cacheBytes]);
        assert.deepEqual(states(held), expected, 'the same registers and memory');
        // How many go and come back is the run's timing: a module let go again and
        // again stays out a while. Some of each on both is what the run was for.
        held.figures.forEach((one, which)=>{
            assert.ok(one?.evictions > 5, `executor ${which}: ${one?.evictions} modules let go`);
            assert.ok(one?.broughtBack > 0,
                `executor ${which}: ${one?.broughtBack} regions brought back`);
        });
    });
}

test('an executor that lets go of its code on a page leaves the page marked for another\'s'
    + ' region there: the other\'s store into that region is seen', async()=>{
    const made = programs(77);
    const [K, FIRST, SECOND] = [0x1234567, 30_000, 20_000];
    // g: add eax, K; ret -- the other executor's alone, on the functions' page.
    const own = { at: OWN, code: [0x05, ...u32(K), 0xc3] };
    // mov ecx, FIRST; L: call g; dec ecx; jnz L; W: cmp dword [FLAG], 0; je W;
    // add dword [g + 1], 3; mov ecx, SECOND; M: call g; dec ecx; jnz M; hlt
    const at = DRIVERS[1];
    const code = [0xb9, ...u32(FIRST)];
    code.push(...call(at + code.length, OWN), 0x49, 0x75, 0xf8);
    code.push(0x83, 0x3d, ...u32(FLAG), 0x00, 0x74, 0xf7);
    code.push(0x83, 0x05, ...u32(OWN + 1), 0x03);
    code.push(0xb9, ...u32(SECOND));
    code.push(...call(at + code.length, OWN), 0x49, 0x75, 0xf8, 0xf4);
    /** @type {Driver} */
    const waiting = { at, code, eax: 0, ebx: 0 };
    /** @type {Driver} */
    const idle = { at, code: [0xf4], eax: 0, ebx: 0 };
    const free = await together(made.functions, [made.drivers[0], idle], [0, 0]);
    // The process's own runs the functions under a ceiling, letting them go on the page
    // where g is, and only once it has halted lets the other go on to its store.
    const run = await together([...made.functions, own, { at: FLAG, code: u32(0) }],
        [made.drivers[0], waiting], [fiveModules(free.figures[0]), 0],
        process=>process.writePhysical(FLAG, new Uint8Array(u32(1))));
    assert.ok(run.figures[0].evictions > 5, `${run.figures[0].evictions} modules let go`);
    assert.equal(run.figures[1]?.evictions, 0);
    assert.equal(run.regs[1](0), (Math.imul(FIRST, K) + Math.imul(SECOND, K + 3)) >>> 0,
        'g ran as written, before the store and after it');
});
