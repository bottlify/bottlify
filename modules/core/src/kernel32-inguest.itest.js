/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The interlocked arithmetic, code in the guest's own kernel32, called
 * through the import as a program calls it, on cork and on the emulator.
 *
 * Each program exits 0, or with the number of the first check that failed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * Bytes, labels, and near jumps to labels, laid out with every displacement
 * filled in.
 *
 * @param {(number[] | string | { jump: number[], to: string })[]} pieces
 * @returns {number[]}
 */
function assemble(pieces){
    /** @type {Map<string, number>} */
    const labels = new Map();
    let at = 0;
    for (const piece of pieces)
    {
        if (typeof piece === 'string')
        {
            labels.set(piece, at);
        }
        else
        {
            at += Array.isArray(piece) ? piece.length : piece.jump.length + 4;
        }
    }
    /** @type {number[]} */
    const out = [];
    for (const piece of pieces)
    {
        if (typeof piece === 'string')
        {
            continue;
        }
        if (Array.isArray(piece))
        {
            out.push(...piece);
            continue;
        }
        const target = labels.get(piece.to);
        assert.ok(target !== undefined, `no label ${piece.to}`);
        out.push(...piece.jump);
        out.push(...u32(target - (out.length + 4)));
    }
    return out;
}

const JNE = [0x0f, 0x85];
const JNZ = JNE;

/**
 * The context `buildExe` hands a program's code, and the few instructions
 * every program here is written in.
 *
 * @param {{ iat: (name: string) => number, at: (name: string) => number }} context
 */
const toolkit = ({ iat, at })=>({
    /** @param {string} name */
    call: name=>[0xff, 0x15, ...u32(iat(name))],
    /** @param {string} name @param {number} [offset] */
    push: (name, offset = 0)=>[0x68, ...u32(at(name) + offset)],
    /** push dword [name] @param {string} name */
    pushFrom: (name, offset = 0)=>[0xff, 0x35, ...u32(at(name) + offset)],
    /** @param {number} value */
    pushValue: value=>[0x68, ...u32(value)],
    /** mov dword [name], value @param {string} name @param {number} value */
    store: (name, value, offset = 0)=>[0xc7, 0x05, ...u32(at(name) + offset), ...u32(value)],
    /** mov [name], eax @param {string} name */
    keep: (name, offset = 0)=>[0xa3, ...u32(at(name) + offset)],
    /** cmp dword [name], value @param {string} name @param {number} value */
    compare: (name, value, offset = 0)=>[0x81, 0x3d, ...u32(at(name) + offset), ...u32(value)],
    /** mov ebx, n: the check that is running, which a failure exits with */
    check: (/** @type {number} */ number)=>[0xbb, ...u32(number)],
    exit: ()=>[0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))],
    /** The shared ending: `fail` exits with the number of the check. */
    fail: ()=>['fail', [0x53, 0xff, 0x15, ...u32(iat('ExitProcess'))]],
    /**
     * CreateThread(NULL, 0, start, NULL, 0, NULL), the handle kept.
     * @param {number} start @param {string} handles @param {number} index
     */
    spawn: (start, handles, index)=>[
        0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(start), 0x6a, 0x00, 0x6a, 0x00,
        0xff, 0x15, ...u32(iat('CreateThread')),
        0xa3, ...u32(at(handles) + index * 4),
    ],
});

/** What the callee-saved registers hold across every call, to be found there after. */
const KEPT = { esi: 0x51515151, edi: 0x7e7e7e7e, ebp: 0x3c3c3c3c };

/**
 * Each interlocked export once or twice through the import: what it answered,
 * what it left in the dword, that it popped exactly its arguments, and that
 * it kept the registers a stdcall callee keeps.
 */
function buildInterlockedExe(){
    const names = ['InterlockedIncrement', 'InterlockedDecrement', 'InterlockedExchange',
        'InterlockedExchangeAdd', 'InterlockedCompareExchange'];
    return buildExe({
        imports: { 'KERNEL32.dll': [...names, 'ExitProcess'] },
        data: { counter: [0, 0, 0, 0], stack: [0, 0, 0, 0] },
        codeSize: 0x600,
        code: context=>{
            const { call, push, pushValue, store, compare, check, exit, fail } = toolkit(context);
            let number = 0;
            /**
             * @param {number[]} pushes  the arguments after the pointer, last first
             * @param {string} name @param {number} answer @param {number} left
             */
            const step = (pushes, name, answer, left)=>[
                check(++number),
                [0x89, 0x25, ...u32(context.at('stack'))],            // mov [stack], esp
                pushes, push('counter'), call(name),
                [0x3b, 0x25, ...u32(context.at('stack'))],            // cmp esp, [stack]
                { jump: JNE, to: 'fail' },
                [0x3d, ...u32(answer)], { jump: JNE, to: 'fail' },     // cmp eax, answer
                compare('counter', left), { jump: JNE, to: 'fail' },
                [0x81, 0xfe, ...u32(KEPT.esi)], { jump: JNE, to: 'fail' },
                [0x81, 0xff, ...u32(KEPT.edi)], { jump: JNE, to: 'fail' },
                [0x81, 0xfd, ...u32(KEPT.ebp)], { jump: JNE, to: 'fail' },
            ];
            return assemble([
                [0xbe, ...u32(KEPT.esi), 0xbf, ...u32(KEPT.edi), 0xbd, ...u32(KEPT.ebp)],
                store('counter', 5),
                ...step([], 'InterlockedIncrement', 6, 6),
                ...step([], 'InterlockedDecrement', 5, 5),
                store('counter', 0),
                ...step([], 'InterlockedDecrement', 0xffffffff, 0xffffffff),
                store('counter', 0x7fffffff),
                ...step([], 'InterlockedIncrement', 0x80000000, 0x80000000),
                store('counter', 5),
                ...step(pushValue(42), 'InterlockedExchange', 5, 42),
                // Comparand first, then the exchange: pushed right to left.
                ...step([...pushValue(42), ...pushValue(7)], 'InterlockedCompareExchange', 42, 7),
                ...step([...pushValue(42), ...pushValue(9)], 'InterlockedCompareExchange', 7, 7),
                ...step(pushValue(10), 'InterlockedExchangeAdd', 7, 17),
                ...step(pushValue(-20 >>> 0), 'InterlockedExchangeAdd', 17, -3 >>> 0),
                exit(),
                ...fail(),
            ]);
        },
    });
}

const WORKERS = 3;
const TURNS = 3000;

/**
 * Three threads counting into two shared dwords through the import, preempted
 * wherever the quantum ends: every increment has to land.
 */
function buildInterlockedRaceExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['InterlockedIncrement', 'InterlockedExchangeAdd',
            'CreateThread', 'ExitThread', 'WaitForMultipleObjects', 'ExitProcess'] },
        data: { counter: [0, 0, 0, 0], total: [0, 0, 0, 0], handles: new Array(16).fill(0) },
        codeSize: 0x200,
        code: context=>{
            const { call, push, compare, check, exit, fail, spawn } = toolkit(context);
            const worker = context.code(0x100);
            const main = assemble([
                ...[0, 1, 2].map(index=>spawn(worker, 'handles', index)),
                [0x6a, 0xff, 0x6a, 0x01], push('handles'), [0x6a, WORKERS],
                call('WaitForMultipleObjects'),
                check(1), compare('counter', WORKERS * TURNS), { jump: JNE, to: 'fail' },
                check(2), compare('total', 3 * WORKERS * TURNS), { jump: JNE, to: 'fail' },
                exit(),
                ...fail(),
            ]);
            const body = assemble([
                [0xbe, ...u32(TURNS)],                                   // mov esi, TURNS
                'turn',
                push('counter'), call('InterlockedIncrement'),
                [0x6a, 0x03], push('total'), call('InterlockedExchangeAdd'),
                [0x4e], { jump: JNZ, to: 'turn' },                       // dec esi; jnz
                [0x6a, 0x00], call('ExitThread'),
            ]);
            return [...main, ...new Array(0x100 - main.length).fill(0x90), ...body];
        },
    });
}

/**
 * Runs a program to its exit, and reads before the machine goes what crossed
 * into the host: the bridge's most frequent calls.
 *
 * @param {Uint8Array} executable @param {'emulator' | 'cork'} engine
 * @param {number} [quantum]
 */
async function run(executable, engine, quantum){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const app = await createApp({
        executable,
        engine,
        quantum,
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
    });
    try
    {
        const code = await app.run({ timeoutMs: 30000 });
        const bridge = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'bridge');
        return {
            code,
            /** @type {[string, number][]} */
            hot: bridge?.metrics?.hot ?? [],
        };
    }
    finally
    {
        await app.dispose();
    }
}

for (const engine of /** @type {const} */ (['cork', 'emulator']))
{
    test(`the interlocked exports answer as Windows does, in the guest, under ${engine}`,
        { timeout: 60000 }, async()=>{
            const { code, hot } = await run(buildInterlockedExe(), engine);
            assert.equal(code, 0, 'the number of the first check that failed');
            assert.deepEqual(hot.filter(([name])=>name.includes('Interlocked')), [],
                'and none of them crossed into the host');
        });

    test(`interlocked increments from three preempted threads all land, under ${engine}`,
        { timeout: 60000 }, async()=>{
            const { code } = await run(buildInterlockedRaceExe(), engine, 97);
            assert.equal(code, 0, '1: an increment was lost; 2: an addition was');
        });
}
