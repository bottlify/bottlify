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
 * @param {Uint8Array} executable @param {'emulator' | 'cork'} engine
 */
async function run(executable, engine){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const app = await createApp({
        executable,
        engine,
        cork: { config: { hotThreshold: 100, feed: 'slice' } },
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
        const code = await app.run({ timeoutMs: 30000 });
        const { metrics } = cpuModule.diagnostics();
        return { code, output: output.join(''), diagnostics: cpuModule.diagnostics(),
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
        });
}

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
        console.log(`cork loop: share ${cork.cork.translatedShare.toFixed(2)},`
            + ` regions ${cork.cork.regions}, exits ${JSON.stringify(cork.cork.exits)}`);
    });
