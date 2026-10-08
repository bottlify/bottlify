/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The remote executor's gate (a second path beside a slice on the process's
 * own host): seeded programs -- loops hot enough to be translated, traps whose
 * handler reads and writes registers and memory and sometimes ends the turn, faults
 * a handler claims and steps over -- run on another executor in a worker of its
 * own leave the registers, the flags and the memory they leave on the
 * process's own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from './cork-host.js';
import { createBell, createRemoteExecutor } from './executor.js';
import * as engine from '../../../../../cork/src/index.js';

const ENGINE_URL = new URL('../../../../../cork/src/index.js', import.meta.url).href;
const MEMORY = 4 << 20;
const CODE = 0x20000;
const DATA = 0x30000;
const TRAP_PORT = 0xb077;
const CONFIG = {
    memorySize: MEMORY, trapPort: TRAP_PORT, entryVector: 0x7000, initialStack: 0x300000,
    closedBelow: 0x10000, cork: { hotThreshold: 4, wasmInterpreter: true },
};
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

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

/**
 * A program: a loop of random work, traps and faults, then `hlt`.
 *
 * @param {(n: number) => number} next
 */
function program(next){
    const body = [];
    const length = 2 + next(10);
    for (let i = 0; i < length; i++)
    {
        switch (next(8))
        {
            case 0: body.push(0x01, 0xd8); break; // add eax, ebx
            case 1: body.push(0x31, 0xc3); break; // xor ebx, eax
            case 2: body.push(0x69, 0xc0, ...u32(next(1 << 20) | 1)); break; // imul eax, imm
            case 3: body.push(0xa3, ...u32(DATA + 4 * next(16))); break; // mov [d], eax
            case 4: body.push(0x03, 0x05, ...u32(DATA + 4 * next(16))); break; // add eax, [d]
            case 5: body.push(0xef); break; // out dx, eax: a trap
            // mov esi, [low]: a fault
            case 6: body.push(0x8b, 0x35, ...u32(next(0x10000) & ~3)); break;
            default: body.push(0xc1, 0xc0, next(32)); break; // rol eax, n
        }
    }
    // mov edx, TRAP_PORT; mov ecx, n; L: body; dec ecx; jnz L; hlt
    const loop = [...body, 0x49, 0x0f, 0x85, ...u32(-(body.length + 1 + 6))];
    return [0xba, ...u32(TRAP_PORT), 0xb9, ...u32(20 + next(40)), ...loop, 0xf4];
}

/**
 * The handlers both runs answer with, on the process's host: a trap folds its
 * value into ebx and a word of memory, and every fifth ends the turn; a fault
 * is claimed and stepped over, counted in edi.
 *
 * @param {any} host
 */
function handle(host){
    let traps = 0;
    host.onTrap((/** @type {number} */ value)=>{
        traps++;
        host.writeReg32('ebx', (host.readReg32('ebx') + value) | 0);
        const at = DATA + 0x80;
        host.writePhysical(at, new Uint8Array(u32((host.readU32(at) ^ value) >>> 0)));
        if (traps % 5 === 0)
        {
            host.stop();
        }
    });
    host.onFault((/** @type {any} */ fault)=>{
        host.writeReg32('eip', fault.eip + 6);
        host.writeReg32('edi', host.readReg32('edi') + 1);
        return true;
    });
}

/** A turn of the event loop. */
const settle = ()=>new Promise(resolve=>setTimeout(resolve, 0));

/** What a run leaves. @param {any} host @param {(name: string) => number} reg */
function outcome(host, reg){
    return {
        regs: REGISTERS.map(name=>reg(name) >>> 0),
        data: Array.from(host.readPhysical(DATA, 0x84)),
    };
}

/**
 * The state both runs begin from, in a block as the process's host sees one.
 * @param {any} host @param {number[]} code @param {(n: number) => number} next
 */
function begin(host, code, next){
    host.writePhysical(CODE, new Uint8Array(code));
    host.writePhysical(DATA, new Uint8Array(0x84).map(()=>next(256)));
    for (const name of ['eax', 'ebx', 'esi', 'edi', 'ebp'])
    {
        host.writeReg32(name, next(1 << 30));
    }
    host.writeReg32('esp', 0x300000);
    host.writeReg32('eip', CODE);
}

test('programs run on another executor in a worker leave what they leave on the process\'s own',
    async()=>{
        const local = createCorkHost({ ...CONFIG, engine });
        const process = createCorkHost({ ...CONFIG, engine, executors: 2 });
        handle(local);
        handle(process);
        const remote = await createRemoteExecutor({ host: process, index: 1, engineUrl: ENGINE_URL,
            config: { ...CONFIG, executors: 2 } });
        try
        {
            const next = random(0xe8ec);
            for (let index = 0; index < 60; index++)
            {
                const code = program(next);
                const seed = next(1 << 30);
                begin(local, code, random(seed));
                for (let turn = 0; turn < 10_000 && (turn === 0 || !local.halted()); turn++)
                {
                    local.runSlice(1 + next(500));
                    await local.cork().translatePending();
                }
                const expected = outcome(local, name=>local.readReg32(name));

                // The process's block set up, then carried to the executor's.
                begin(process, code, random(seed));
                remote.block().set(process.block());
                let slice = remote.runSlice(1 + next(500));
                for (let turn = 1; turn < 10_000 && !slice.halted; turn++)
                {
                    // A turn of the event loop between slices, as a scheduler's, in
                    // which the executor's translations land.
                    await settle();
                    slice = remote.runSlice(1 + next(500));
                }
                const view = new DataView(remote.block().buffer, remote.block().byteOffset);
                const layout = process.blockLayout();
                const actual = outcome(process,
                    name=>view.getUint32(layout.regs + REGISTERS.indexOf(name) * 4, true));
                assert.equal(slice.fault, null);
                assert.deepEqual(actual, expected, `program ${index}: ${code.map(b=>b
                    .toString(16).padStart(2, '0')).join(' ')}`);
            }
            assert.ok(local.cork().diagnostics().modules > 0, 'translated on the process\'s');
            assert.ok((await remote.diagnostics())?.modules > 0, 'and on the other');
        }
        finally
        {
            remote.close();
        }
    });

test('a store on one executor into code another translated reaches the other\'s next slice',
    async()=>{
        const process = createCorkHost({ ...CONFIG, engine, executors: 2 });
        handle(process);
        const remote = await createRemoteExecutor({ host: process, index: 1, engineUrl: ENGINE_URL,
            config: { ...CONFIG, executors: 2 } });
        const LOOP = 0x40000;
        const WRITER = 0x41000;
        // L: mov eax, imm; add ebx, eax; dec ecx; jnz L; hlt
        const loop = [0xb8, ...u32(0x11111111), 0x01, 0xc3, 0x49, 0x75, 0xf6, 0xf4];
        /** mov dword [L+1], value; hlt @param {number} value */
        const writer = value=>[0xc7, 0x05, ...u32(LOOP + 1), ...u32(value), 0xf4];
        const view = new DataView(remote.block().buffer, remote.block().byteOffset);
        const layout = process.blockLayout();
        /** @param {string} name */
        const remoteReg = name=>view.getUint32(layout.regs + REGISTERS.indexOf(name) * 4, true);
        /** @param {string} name @param {number} value */
        const setRemote = (name, value)=>(name === 'eip'
            ? view.setUint32(layout.eip, value, true)
            : view.setUint32(layout.regs + REGISTERS.indexOf(name) * 4, value >>> 0, true));
        /** Runs the loop to its `hlt` on the process's executor: ebx. */
        const localLoop = async()=>{
            process.writeReg32('ecx', 200);
            process.writeReg32('ebx', 0);
            process.writeReg32('eip', LOOP);
            for (let turn = 0; turn < 1000 && (turn === 0 || !process.halted()); turn++)
            {
                process.runSlice(50);
                await process.cork().translatePending();
            }
            return process.readReg32('ebx') >>> 0;
        };
        /** The same on the other executor. @param {number} at */
        const remoteRun = async(/** @type {number} */ at)=>{
            setRemote('ecx', 200);
            setRemote('ebx', 0);
            setRemote('esp', 0x300000);
            setRemote('eip', at);
            let slice = remote.runSlice(50);
            for (let turn = 1; turn < 1000 && !slice.halted; turn++)
            {
                await settle();
                slice = remote.runSlice(50);
            }
            return remoteReg('ebx');
        };
        /** @param {number} value */
        const times = value=>Math.imul(value, 200) >>> 0;
        try
        {
            process.writePhysical(LOOP, new Uint8Array(loop));
            process.writePhysical(WRITER, new Uint8Array(writer(0x22222222)));
            process.writeReg32('esp', 0x300000);
            assert.equal(await localLoop(), times(0x11111111));
            const published = process.cork().diagnostics().modules;
            assert.ok(published > 0, 'the loop was translated');
            // The other executor's store, into the code the first translated.
            await remoteRun(WRITER);
            assert.equal(await localLoop(), times(0x22222222), 'the first ran the stored code');
            assert.ok(process.cork().diagnostics().invalidations > 0, 'its translation went');

            // And the other way: the loop hot on the other executor, the store on the first.
            process.writePhysical(LOOP + 1, new Uint8Array(u32(0x33333333)));
            assert.equal(await remoteRun(LOOP), times(0x33333333), 'a host write reached it');
            assert.equal(await remoteRun(LOOP), times(0x33333333));
            assert.ok((await remote.diagnostics())?.modules > 0, 'translated there');
            process.writePhysical(WRITER, new Uint8Array(writer(0x44444444)));
            process.writeReg32('eip', WRITER);
            for (let turn = 0; turn < 10 && (turn === 0 || !process.halted()); turn++)
            {
                process.runSlice(50);
            }
            assert.equal(await remoteRun(LOOP), times(0x44444444), 'the other ran the stored code');
            assert.ok((await remote.diagnostics())?.invalidations > 0, 'its translation went');
        }
        finally
        {
            remote.close();
        }
    });

test('two executors at once: interlocked counters, a spin lock and a compare-and-swap loop '
    + 'lose no update', async()=>{
    const config = { ...CONFIG, executors: 3, cork: { ...CONFIG.cork, atomic: true } };
    const process = createCorkHost({ ...config, engine });
    process.onTrap(()=>{});
    /** @type {any[]} */
    const faults = [];
    process.onFault((/** @type {any} */ fault)=>{
        faults.push(fault);
        return false;
    });
    const bell = createBell();
    const remotes = await Promise.all([1, 2].map(index=>createRemoteExecutor({ host: process,
        index, engineUrl: ENGINE_URL, config, bell })));
    const COUNTER = DATA;
    const GUARDED = DATA + 8;
    const LOCK = DATA + 16;
    const SWAPPED = DATA + 24;
    const N = 30_000;
    const at = 0x50000;
    // L: lock inc [COUNTER]
    //    S: mov eax, 1; xchg [LOCK], eax; test eax, eax; jnz S
    //    inc dword [GUARDED]; mov dword [LOCK], 0
    //    mov eax, [SWAPPED]; C: lea edx, [eax+1]; lock cmpxchg [SWAPPED], edx; jnz C
    //    dec ecx; jnz L; hlt
    const body = [
        0xf0, 0xff, 0x05, ...u32(COUNTER),
        0xb8, ...u32(1), 0x87, 0x05, ...u32(LOCK), 0x85, 0xc0, 0x75, 0xf1,
        0xff, 0x05, ...u32(GUARDED), 0xc7, 0x05, ...u32(LOCK), ...u32(0),
        0xa1, ...u32(SWAPPED), 0x8d, 0x50, 0x01, 0xf0, 0x0f, 0xb1, 0x15, ...u32(SWAPPED),
        0x75, 0xf3,
    ];
    const code = [...body, 0x49, 0x0f, 0x85, ...u32(-(body.length + 1 + 6)), 0xf4];
    try
    {
        process.writePhysical(at, new Uint8Array(code));
        process.writePhysical(DATA, new Uint8Array(32));
        for (const remote of remotes)
        {
            remote.onBlock(()=>{
                process.writeReg32('ecx', N);
                process.writeReg32('esp', 0x300000 - remote.index * 0x10000);
                process.writeReg32('eip', at);
            });
        }
        /** @type {boolean[]} */
        const halted = [false, false];
        const started = Date.now();
        remotes.forEach(remote=>remote.start(1 + 5000));
        while (halted.includes(false) && Date.now() - started < 120_000)
        {
            const seen = bell.rung();
            let moved = false;
            remotes.forEach((remote, i)=>{
                const ended = remote.step();
                if (ended !== null)
                {
                    moved = true;
                    assert.equal(ended.fault, null);
                    if (ended.halted)
                    {
                        halted[i] = true;
                    }
                    else
                    {
                        remote.start(5000);
                    }
                }
            });
            if (!moved)
            {
                // A turn of the event loop now and then, as the process's own would take.
                if (Atomics.load(new Int32Array(bell.buffer), 0) === seen)
                {
                    await settle();
                }
            }
        }
        assert.deepEqual(faults, []);
        assert.deepEqual(halted, [true, true], 'both ran to the end');
        assert.equal(process.readU32(COUNTER), 2 * N, 'lock inc');
        assert.equal(process.readU32(GUARDED), 2 * N, 'a plain increment under an xchg lock');
        assert.equal(process.readU32(SWAPPED), 2 * N, 'a compare-and-swap loop');
        const translated = await Promise.all(remotes.map(remote=>remote.diagnostics()));
        assert.ok(translated.every(one=>one?.modules > 0), 'translated on both');
    }
    finally
    {
        remotes.forEach(remote=>remote.close());
    }
});
