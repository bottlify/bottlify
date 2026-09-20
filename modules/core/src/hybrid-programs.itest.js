/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Whole programs under `hybrid` with the translator attached: the bridge's
 * calls, the loader's writes, threads and the exit path all cross between
 * the two executors, and the program must end as it ends on the emulator
 * alone. A built executable with a hot loop that calls a kernel32 import on
 * every iteration proves the loop translates while the import's stub runs
 * on the emulator; the shipped fixtures prove nothing else changes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { cpuModule } from './layers/cpu/module.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);
const ITERATIONS = 2_000_000;
/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * A loop that calls lstrlenA("abc") ITERATIONS times and exits with the sum
 * of the lengths, modulo 256.
 */
function buildLoopExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['lstrlenA', 'ExitProcess'] },
        data: { text: [0x61, 0x62, 0x63, 0] },
        codeSize: 0x40,
        code: ({ iat, at })=>[
            0xbe, ...u32(ITERATIONS),            //     mov esi, N
            0x31, 0xff,                          //     xor edi, edi
            0x68, ...u32(at('text')),            // L:  push text
            0xff, 0x15, ...u32(iat('lstrlenA')), //     call [lstrlenA]
            0x01, 0xc7,                          //     add edi, eax
            0x4e,                                //     dec esi
            0x75, 0xf0,                          //     jnz L
            0x81, 0xe7, ...u32(0xff),            //     and edi, 0xff
            0x57,                                //     push edi
            0xff, 0x15, ...u32(iat('ExitProcess')), // call [ExitProcess]
        ],
    });
}

/** @param {Uint8Array} executable @param {'emulator' | 'hybrid'} engine */
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
        const code = await app.run({ timeoutMs: 20000 });
        const { metrics } = cpuModule.diagnostics();
        const cork = /** @type {any} */ (metrics).cork;
        return { code, output: output.join(''), cork };
    }
    finally
    {
        await app.dispose();
    }
}

test('a loop calling a kernel32 import translates, the import runs on the emulator, and the exit'
    + ' code agrees', { timeout: 60000 }, async()=>{
    const exe = buildLoopExe();
    const reference = await run(exe, 'emulator');
    assert.equal(reference.code, (3 * ITERATIONS) & 0xff);
    assert.equal(reference.cork, null);
    const hybrid = await run(exe, 'hybrid');
    assert.equal(hybrid.code, reference.code);
    assert.equal(hybrid.output, reference.output);
    assert.ok(hybrid.cork, 'the translator reports');
    assert.ok(hybrid.cork.regions >= 1,
        `regions ${hybrid.cork.regions}, refused ${JSON.stringify(hybrid.cork.refused)}`);
    assert.ok(hybrid.cork.translatedShare > 0.2,
        `share ${hybrid.cork.translatedShare}, exits ${JSON.stringify(hybrid.cork.exits)}`);
});

for (const name of ['hello.exe', 'threads.exe', 'session.exe'])
{
    test(`${name} ends under hybrid as it ends on the emulator`, { timeout: 60000 }, async()=>{
        const exe = new Uint8Array(
            await readFile(new URL(`../test/fixtures/${name}`, import.meta.url)));
        const reference = await run(exe, 'emulator');
        const hybrid = await run(exe, 'hybrid');
        assert.equal(hybrid.code, reference.code);
        assert.equal(hybrid.output, reference.output);
        assert.ok(hybrid.cork, 'the translator was attached');
    });
}
