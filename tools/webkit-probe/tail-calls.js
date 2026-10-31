/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shapes of wasm tail call cork's translated code uses, one module set
 * each, run until the engine's tiers have compiled them: which of them takes a
 * browser's page down. An iPhone's WebKit killed the page with a
 * pointer-authentication failure as cork's regions began to run and ran with
 * the same code translated without tail calls; this says which call it was.
 *
 * Each test is a chain: a function that, with its count not yet zero, counts a
 * transfer in memory (where it has one) and passes the count less one on by
 * the tail call under test. `tail-calls.html` runs them one at a time; loaded
 * as a worker (`?worker`) this module runs the one it is sent.
 */

import { Body, EMPTY, ModuleBuilder, ValType } from '/cork/src/wasm/encoder.js';
import { createCorkRuntime } from '/cork/src/runtime/runtime.js';
import { ownLayout, pagesFor, tablesSize } from '/cork/src/runtime/layout.js';

const I32_EQZ = 0x45;
const I32_ADD = 0x6a;
const I32_SUB = 0x6b;
const ROUNDS = 20;
const LENGTH = 100000;

/**
 * A chain function's body: zero ends it, else it counts a transfer at memory
 * word 0 and hands n - 1 (and the other parameters as they came) to `tail`.
 *
 * @param {number} params @param {boolean} memory @param {(b: Body) => void} tail
 */
function chainBody(params, memory, tail){
    const b = new Body();
    b.localGet(0).op(I32_EQZ).if(EMPTY).i32const(0).return().end();
    if (memory)
    {
        b.i32const(0).i32const(0).load('i32').i32const(1).op(I32_ADD).store('i32');
    }
    b.localGet(0).i32const(1).op(I32_SUB);
    for (let i = 1; i < params; i++)
    {
        b.localGet(i);
    }
    tail(b);
    return b.toBytes();
}

/** @param {number} params */
const chainType = (m, params)=>m.type({ params: new Array(params).fill(ValType.i32),
    results: [ValType.i32] });

/**
 * A module of one chain function `f` that tail-calls through the imported
 * table's `slot`, over an imported memory if `memory` says so.
 *
 * @param {{ params?: number, memory?: 'plain' | 'shared' | null, slot: number,
 *     importNext?: boolean }} spec
 */
function tableModule({ params = 1, memory = null, slot, importNext = false }){
    const m = new ModuleBuilder();
    const type = chainType(m, params);
    if (memory)
    {
        m.importMemory('env', 'memory', { min: 1, max: 1, shared: memory === 'shared' });
    }
    m.importTable('env', 'table', 64);
    const next = importNext ? m.importFunction('env', 'next', type) : -1;
    m.function(type, [], chainBody(params, memory !== null, b=>{
        if (importNext)
        {
            b.returnCall(next);
        }
        else
        {
            b.i32const(slot).returnCallIndirect(type, 0);
        }
    }), { exportAs: 'f' });
    return new WebAssembly.Module(m.toBytes());
}

/** @param {WebAssembly.Memory | null} memory */
const memoryOf = memory=>(memory === null ? 0 : new Int32Array(memory.buffer)[0]);

/**
 * Runs a chain from JS: ROUNDS of LENGTH transfers, each round from a fresh
 * call so the entry tiers up with the chain.
 *
 * @param {(n: number) => number} f @param {WebAssembly.Memory | null} memory
 * @param {number} params
 */
function drive(f, memory, params){
    const extra = new Array(params - 1).fill(7);
    for (let round = 0; round < ROUNDS; round++)
    {
        const got = /** @type {any} */ (f)(LENGTH, ...extra);
        if (got !== 0)
        {
            throw new Error(`round ${round} returned ${got}`);
        }
    }
    const counted = memoryOf(memory);
    if (memory !== null && counted !== ROUNDS * LENGTH)
    {
        throw new Error(`memory counted ${counted} transfers of ${ROUNDS * LENGTH}`);
    }
    return `${ROUNDS * LENGTH} transfers`;
}

/** @param {'plain' | 'shared' | null} kind */
const makeMemory = kind=>(kind === null ? null
    : new WebAssembly.Memory({ initial: 1, maximum: 1, shared: kind === 'shared' }));

/**
 * A ring of `count` instances, each its own module, each tail-calling the
 * next through the shared table: cork's regions, module to module.
 *
 * @param {{ count: number, params?: number, memory?: 'plain' | 'shared' | null }} spec
 */
function ring({ count, params = 1, memory = null }){
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: 64 });
    const mem = makeMemory(memory);
    const env = { table, ...(mem ? { memory: mem } : {}) };
    for (let i = 0; i < count; i++)
    {
        const module = tableModule({ params, memory, slot: (i + 1) % count });
        table.set(i, new WebAssembly.Instance(module, { env }).exports.f);
    }
    return drive(/** @type {any} */ (table.get(0)), mem, params);
}

const CODE = 0x1000;

/**
 * Real cork, as the engine runs it, on a guest loop: mov ecx, n; L: call F;
 * dec ecx; jnz L; hlt; F: inc edx; ret. With `split` the callee is translated
 * first, alone, so it and the loop are two modules and every call and return
 * transfers between instances; without, one module. `cross` false is the
 * engine's workaround for iOS 27 (crossTailCalls: false with dispatch): a
 * transfer out of a module returns to this loop, one inside it stays a tail call.
 *
 * @param {{ cross: boolean, split: boolean, shared?: boolean, n?: number }} spec
 */
async function corkLoop({ cross, split, shared = false, n = 200000 }){
    const layout = ownLayout({ ramSize: 4 << 20, hashSlots: 1 << 16 });
    const pages = pagesFor(layout, tablesSize(layout));
    const memory = new WebAssembly.Memory({ initial: pages,
        ...(shared ? { maximum: pages, shared: true } : {}) });
    const bytes = ()=>new Uint8Array(memory.buffer);
    const view = ()=>new DataView(memory.buffer);
    view().setUint8(layout.x87Empty, 0xff);
    view().setUint16(layout.x87Control, 0x37f, true);
    const runtime = createCorkRuntime({ memory, layout,
        config: { worker: false, leafCalls: false, mergeAfter: 0, callReturn: false,
            dispatch: true, crossTailCalls: cross },
        read: address=>bytes()[layout.ramBase + address],
        imports: { trap: ()=>0, rdtsc: ()=>0n } });
    bytes().set([0xb9, n & 0xff, n >>> 8 & 0xff, n >>> 16 & 0xff, 0, 0xe8, 0x04, 0, 0, 0,
        0x49, 0x75, 0xf8, 0xf4, 0x42, 0xc3], layout.ramBase + CODE);
    view().setUint32(layout.regs + 4 * 4, 0x80000, true);
    if (split)
    {
        runtime.noteHot(CODE + 14);
        await runtime.translatePending();
    }
    runtime.noteHot(CODE);
    await runtime.translatePending();
    // The engine's slice loop: each exit entered again where it left.
    let left = 0;
    let exit = runtime.run(runtime.entryOf(CODE), 100_000_000);
    while (exit.kind === 'untranslated' && left < 10 * n)
    {
        left++;
        exit = runtime.run(runtime.entryOf(view().getUint32(layout.eip, true)), 100_000_000);
    }
    const edx = view().getUint32(layout.regs + 2 * 4, true);
    if (exit.kind !== 'halt' || edx !== n)
    {
        throw new Error(`stopped ${exit.kind}, edx ${edx} of ${n}`);
    }
    return `${n} calls, ${left} entries from the loop, ${runtime.diagnostics().modules} modules`;
}

/** @type {Record<string, { title: string, run: () => string | Promise<string> }>} */
export const TESTS = {
    'direct-self': {
        title: 'return_call to itself, one module',
        run: ()=>{
            const m = new ModuleBuilder();
            const type = chainType(m, 1);
            m.function(type, [], chainBody(1, false, b=>b.returnCall(0)), { exportAs: 'f' });
            const { f } = /** @type {any} */ (new WebAssembly.Instance(
                new WebAssembly.Module(m.toBytes()), {}).exports);
            return drive(f, null, 1);
        },
    },
    'direct-pair': {
        title: 'return_call between two functions of one module',
        run: ()=>{
            const m = new ModuleBuilder();
            const type = chainType(m, 1);
            m.function(type, [], chainBody(1, false, b=>b.returnCall(1)), { exportAs: 'f' });
            m.function(type, [], chainBody(1, false, b=>b.returnCall(0)));
            const { f } = /** @type {any} */ (new WebAssembly.Instance(
                new WebAssembly.Module(m.toBytes()), {}).exports);
            return drive(f, null, 1);
        },
    },
    'indirect-own-table': {
        title: 'return_call_indirect through the module\'s own table, same instance',
        run: ()=>{
            const m = new ModuleBuilder();
            const type = chainType(m, 1);
            m.table(2);
            m.function(type, [], chainBody(1, false, b=>b.i32const(1).returnCallIndirect(type, 0)),
                { exportAs: 'f' });
            m.function(type, [], chainBody(1, false, b=>b.i32const(0).returnCallIndirect(type, 0)));
            m.element(0, [0, 1]);
            const { f } = /** @type {any} */ (new WebAssembly.Instance(
                new WebAssembly.Module(m.toBytes()), {}).exports);
            return drive(f, null, 1);
        },
    },
    'indirect-imported-same-instance': {
        title: 'return_call_indirect through an imported table to its own instance',
        run: ()=>{
            const table = new WebAssembly.Table({ element: 'anyfunc', initial: 64 });
            const f = new WebAssembly.Instance(tableModule({ slot: 0 }), { env: { table } })
                .exports.f;
            table.set(0, f);
            return drive(/** @type {any} */ (f), null, 1);
        },
    },
    'indirect-cross-2': {
        title: 'return_call_indirect between two instances, no memory',
        run: ()=>ring({ count: 2 }),
    },
    'indirect-cross-2-memory': {
        title: 'return_call_indirect between two instances over one memory',
        run: ()=>ring({ count: 2, memory: 'plain' }),
    },
    'indirect-cross-2-shared': {
        title: 'return_call_indirect between two instances over one shared memory',
        run: ()=>ring({ count: 2, memory: 'shared' }),
    },
    'import-cross': {
        title: 'return_call to an imported function of another instance',
        run: ()=>{
            const table = new WebAssembly.Table({ element: 'anyfunc', initial: 64 });
            // B goes back to A through the table; A reaches B by its import.
            const b = new WebAssembly.Instance(tableModule({ slot: 0 }), { env: { table } })
                .exports.f;
            const a = new WebAssembly.Instance(tableModule({ slot: 0, importNext: true }),
                { env: { table, next: b } }).exports.f;
            table.set(0, a);
            return drive(/** @type {any} */ (a), null, 1);
        },
    },
    'import-js': {
        title: 'return_call to an imported JavaScript function',
        run: ()=>{
            const m = new ModuleBuilder();
            const type = chainType(m, 1);
            const js = m.importFunction('env', 'js', type);
            m.function(type, [], new Body().localGet(0).returnCall(js).toBytes(),
                { exportAs: 'f' });
            let seen = 0;
            const { f } = /** @type {any} */ (new WebAssembly.Instance(
                new WebAssembly.Module(m.toBytes()), { env: { js: n=>{ seen += n; return 0; } } })
                .exports);
            for (let i = 0; i < ROUNDS * LENGTH / 10; i++)
            {
                f(1);
            }
            if (seen !== ROUNDS * LENGTH / 10)
            {
                throw new Error(`the import saw ${seen}`);
            }
            return `${seen} calls`;
        },
    },
    'cork-ring': {
        title: 'cork\'s shape: 6 parameters, shared memory, a ring of 32 instances',
        run: ()=>ring({ count: 32, params: 6, memory: 'shared' }),
    },
    'hack-one-module': {
        title: 'real cork with the iOS 27 workaround, loop and callee in one module',
        run: ()=>corkLoop({ cross: false, split: false }),
    },
    'hack-two-modules': {
        title: 'real cork with the iOS 27 workaround, loop and callee in two modules',
        run: ()=>corkLoop({ cross: false, split: true }),
    },
    'hack-two-modules-shared': {
        title: 'real cork with the iOS 27 workaround, two modules, shared memory',
        run: ()=>corkLoop({ cross: false, split: true, shared: true }),
    },
    'cork-without-hack': {
        title: 'real cork without the workaround, two modules (iOS 27 should crash here)',
        run: ()=>corkLoop({ cross: true, split: true }),
    },
};

/** Tests run again in a worker, where cork runs. */
export const IN_WORKER = ['indirect-cross-2', 'indirect-cross-2-shared', 'import-cross',
    'cork-ring', 'hack-two-modules-shared'];

if (typeof document === 'undefined' && new URL(import.meta.url).searchParams.has('worker'))
{
    self.onmessage = async({ data })=>{
        try
        {
            self.postMessage({ ok: await TESTS[data].run() });
        }
        catch (e){
            self.postMessage({ error: String(/** @type {any} */ (e)?.message ?? e) });
        }
    };
}
