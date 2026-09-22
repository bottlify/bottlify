/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Whole programs under `cork` with the emulator's machine absent (plan step
 * 5.3): the interpreter runs the cold code, the hotness the interpreter counts
 * forms regions at the threshold, and the program ends as it ends on the
 * emulator alone. The same fixtures `hybrid-programs.itest.js` runs -- `hello`,
 * a calling loop (`imports`), `qsort` (callbacks) and the threaded fixture --
 * prove the scheduler, the loader and the trap channel still agree when the
 * only executor is cork's own.
 *
 * The emulator is read only to produce the reference each program is judged
 * against; the cork run itself loads nothing of it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { cpuModule } from './layers/cpu/module.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);
/** @param {string} name */
const FIXTURE = name=>new URL(`../test/fixtures/${name}`, import.meta.url);
const ITERATIONS = 2_000_000;
const missing = ['v86.wasm', 'libv86.mjs']
    .filter((/** @type {string} */ name)=>!existsSync(new URL(name, PREBUILT)));

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** A loop that calls lstrlenA("abc") ITERATIONS times and exits with the sum. */
function buildLoopExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['lstrlenA', 'ExitProcess'] },
        data: { text: [0x61, 0x62, 0x63, 0] },
        codeSize: 0x40,
        code: ({ iat, at })=>[
            0xbe, ...u32(ITERATIONS),
            0x31, 0xff,
            0x68, ...u32(at('text')),
            0xff, 0x15, ...u32(iat('lstrlenA')),
            0x01, 0xc7,
            0x4e,
            0x75, 0xf0,
            0x81, 0xe7, ...u32(0xff),
            0x57,
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
}

/**
 * Calls an import nothing claims -- which returns zero through the stubs so a
 * callback or an unresolved import's return is the shape -- and then returns
 * into the entry vector, where `BOUND` sits. The emulator's decoder consumes
 * that instruction and carries on, so cork must too: the program exits 42 on
 * both. This is the path the real-route run stopped on at 0x7000.
 */
function buildVectorReturnExe(){
    return buildExe({
        imports: { 'msvcrt.dll': ['no_such_import'], 'KERNEL32.dll': ['ExitProcess'] },
        data: {},
        codeSize: 0x80,
        code: ({ iat, code })=>{
            const atExit = code(0x40);
            const rel = atExit - 0x7007; // the jmp after `62 10`, from 0x7002
            const first = ((rel & 0xff) << 24 | 0x00e91062) >>> 0; // 62 10 e9 rel0
            const second = rel >>> 8;
            const atJmp = code(26);
            return [
                0xc7, 0x05, ...u32(0x7000), ...u32(first), // mov dword [0x7000], ...
                0xc7, 0x05, ...u32(0x7004), ...u32(second),
                0xff, 0x15, ...u32(iat('no_such_import')), // call the unresolved import
                0xe9, ...u32(0x7000 - (atJmp + 5)), // jmp 0x7000
                ...new Array(0x40 - 31).fill(0x90),
                0x6a, 0x2a, 0xff, 0x15, ...u32(iat('ExitProcess')), // exit 42
                ...new Array(20).fill(0x90),
            ];
        },
    });
}

/**
 * @param {Uint8Array} executable @param {'emulator' | 'cork'} engine
 */
async function run(executable, engine){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const app = await createApp({
        executable,
        engine,
        cork: { config: { feed: 'slice' } },
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
    });
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));
    try
    {
        const began = performance.now();
        const code = await app.run({ timeoutMs: 30000 });
        const ms = performance.now() - began;
        const { metrics } = cpuModule.diagnostics();
        return { code, output: output.join(''), diagnostics: cpuModule.diagnostics(), ms,
            instructions: /** @type {any} */ (metrics).instructions,
            cork: /** @type {any} */ (metrics).cork };
    }
    finally
    {
        await app.dispose();
    }
}

test('hello ends under cork as it ends on the emulator, with the emulator absent',
    { skip: missing.length > 0 && `missing ${missing.join(', ')}`, timeout: 60000 }, async()=>{
        const exe = new Uint8Array(await readFile(FIXTURE('hello.exe')));
        const reference = await run(exe, 'emulator');
        const cork = await run(exe, 'cork');
        assert.equal(cork.code, reference.code);
        assert.equal(cork.output, reference.output);
        assert.equal(cork.diagnostics.metrics?.engine, 'cork');
    });

for (const name of ['qsort.exe', 'threads.exe'])
{
    test(`${name} ends under cork as it ends on the emulator`,
        { skip: missing.length > 0 && `missing ${missing.join(', ')}`, timeout: 60000 }, async()=>{
            const exe = new Uint8Array(await readFile(FIXTURE(name)));
            const reference = await run(exe, 'emulator');
            const cork = await run(exe, 'cork');
            assert.equal(cork.code, reference.code);
            assert.equal(cork.output, reference.output);
            assert.ok(cork.cork.regions >= 1,
                `no region formed: ${JSON.stringify(cork.cork)}`);
            // The loading phase: how cork runs the program against the
            // emulator, and where the translation time went. These programs are
            // short and boot-dominated, so the instruction counts and the split
            // say more than a rate rounded to zero.
            console.log(`${name}: share ${cork.cork.translatedShare.toFixed(3)},`
                + ` regions ${cork.cork.regions},`
                + ` cork ${cork.instructions} instr in ${cork.ms.toFixed(1)} ms vs`
                + ` emulator ${reference.instructions} in ${reference.ms.toFixed(1)} ms,`
                + ` translateMs ${cork.cork.translateMs.toFixed(0)}`
                + ` (forming ${cork.cork.formingMs.toFixed(0)},`
                + ` lookup ${cork.cork.lookupMs.toFixed(0)},`
                + ` emit ${cork.cork.emitMs.toFixed(0)},`
                + ` encode ${cork.cork.encodeMs.toFixed(0)},`
                + ` store ${cork.cork.storeMs.toFixed(0)},`
                + ` instantiate ${cork.cork.instantiateMs.toFixed(0)},`
                + ` publish ${cork.cork.publishMs.toFixed(0)},`
                + ` worker ${cork.cork.workerMs.toFixed(0)})`);
        });
}

test('a return into the entry vector runs BOUND under cork as on the emulator',
    { skip: missing.length > 0 && `missing ${missing.join(', ')}`, timeout: 60000 }, async()=>{
        const exe = buildVectorReturnExe();
        const reference = await run(exe, 'emulator');
        const cork = await run(exe, 'cork');
        assert.equal(reference.code, 42, 'the emulator ran past BOUND');
        assert.equal(cork.code, reference.code,
            `cork stopped where the emulator carried on: ${JSON.stringify(cork.cork)}`);
        assert.equal(cork.output, reference.output);
    });

test('a loop calling an import runs and translates under cork',
    { skip: missing.length > 0 && `missing ${missing.join(', ')}`, timeout: 60000 }, async()=>{
        const exe = buildLoopExe();
        const reference = await run(exe, 'emulator');
        assert.equal(reference.code, (3 * ITERATIONS) & 0xff);
        const cork = await run(exe, 'cork');
        assert.equal(cork.code, reference.code);
        assert.equal(cork.output, reference.output);
        assert.ok(cork.cork.regions >= 1, `no region formed: ${JSON.stringify(cork.cork)}`);
        assert.ok(cork.cork.translatedShare > 0.9,
            `the hot loop translated: share ${cork.cork.translatedShare},`
            + ` exits ${JSON.stringify(cork.cork.exits)}`);
        // The loop traps an import every iteration, so its rate is the trap
        // channel's cost as much as the executor's and sits within noise of
        // the emulator's; the compute loop below is where the executor shows.
        const corkRate = cork.instructions / cork.ms / 1000;
        const emulatorRate = reference.instructions / reference.ms / 1000;
        console.log(`cork loop: share ${cork.cork.translatedShare.toFixed(2)},`
            + ` regions ${cork.cork.regions},`
            + ` cork ${corkRate.toFixed(0)} M/s vs emulator ${emulatorRate.toFixed(0)} M/s`);
        assert.ok(corkRate >= emulatorRate * 0.6,
            `cork ran the trap loop at ${corkRate.toFixed(1)} M/s against the`
            + ` emulator's ${emulatorRate.toFixed(1)} M/s`);
    });

/**
 * A compute-bound loop, no host call in it: N iterations of 32 dependent
 * adds. This is the shape the step is judged on -- the loading and inner
 * loops of real code -- where the translation threshold decides whether the
 * second visit runs interpreted or translated.
 */
function buildComputeExe(count = 2_000_000){
    const body = 32;
    return buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        data: {},
        codeSize: 0x400,
        code: ({ iat, code })=>{
            const loop = code(5);
            const adds = Array.from({ length: body }, ()=>[0x83, 0xc3, 0x01]).flat();
            const jnzAt = 5 + adds.length + 1;
            const rel = loop - (code(jnzAt) + 2);
            return [
                0xb8, ...u32(count), // mov eax, N
                0x31, 0xdb, // xor ebx, ebx
                ...adds,
                0x48, // dec eax
                0x75, rel & 0xff, // jnz loop
                0x53, // push ebx
                0xff, 0x15, ...u32(iat('ExitProcess')),
                ...new Array(20).fill(0x90),
            ];
        },
    });
}

test('a cold loop becomes a region on its second visit',
    { skip: missing.length > 0 && `missing ${missing.join(', ')}`, timeout: 60000 }, async()=>{
        // Eight iterations are more than the default threshold of two and far
        // fewer than the sampler's old two thousand: before the translation
        // policy was lowered for cork this loop stayed interpreted and formed
        // no region at all.
        const exe = buildComputeExe(8);
        const cork = await run(exe, 'cork');
        assert.ok(cork.cork.regions >= 1,
            `the cold loop never became a region: ${JSON.stringify(cork.cork)}`);
    });

test('a compute loop runs under cork not below the emulator',
    { skip: missing.length > 0 && `missing ${missing.join(', ')}`, timeout: 120000 }, async()=>{
        const exe = buildComputeExe();
        const reference = await run(exe, 'emulator');
        const cork = await run(exe, 'cork');
        assert.equal(cork.code, reference.code);
        assert.ok(cork.cork.translatedShare > 0.9,
            `the loop translated: share ${cork.cork.translatedShare}`);
        const corkRate = cork.instructions / cork.ms / 1000;
        const emulatorRate = reference.instructions / reference.ms / 1000;
        console.log(`cork compute: share ${cork.cork.translatedShare.toFixed(2)},`
            + ` regions ${cork.cork.regions},`
            + ` cork ${corkRate.toFixed(0)} M/s vs emulator ${emulatorRate.toFixed(0)} M/s`);
        assert.ok(corkRate >= emulatorRate,
            `cork ran the compute loop at ${corkRate.toFixed(1)} M/s against the`
            + ` emulator's ${emulatorRate.toFixed(1)} M/s`);
    });
