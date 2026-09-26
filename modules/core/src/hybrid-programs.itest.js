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
import { buildExe } from '../../../tools/make-pe.mjs';

/**
 * A layer's report from the app's own graph: every graph has module objects of
 * its own, so the exported module is not the one the app's machine was made by.
 *
 * @param {any} app @param {string} name
 * @returns {any}
 */
const layerOf = (app, name)=>app.diagnostics()
    .find((/** @type {any} */ layer)=>layer.name === name);

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
        const { metrics } = layerOf(app, 'cpu');
        const cork = /** @type {any} */ (metrics).cork;
        return { code, output: output.join(''), cork };
    }
    catch (e){
        // The translator's report goes with the rejection: the machine is
        // gone once the app is disposed.
        const { metrics } = layerOf(app, 'cpu');
        /** @type {any} */ (e).cork = /** @type {any} */ (metrics).cork;
        throw e;
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
    // The loop, the stub's return and the call channel all translated: one
    // crossing out and one back per call, no emulator turn.
    assert.ok(hybrid.cork.translatedShare > 0.9,
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

/** A hot loop, then an undefined instruction: the fault comes from translated code. */
function buildFaultExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        codeSize: 0x40,
        code: ()=>[
            0xb9, ...u32(2_000_000),     //     mov ecx, N
            0x49,                        // L:  dec ecx
            0x75, 0xfd,                  //     jnz L
            0x0f, 0x0b,                  //     ud2
            0xf4,                        //     hlt
        ],
    });
}

/**
 * The run's rejection, for a program that faults.
 * @param {Uint8Array} executable @param {'emulator' | 'hybrid'} engine
 */
async function fault(executable, engine){
    try
    {
        await run(executable, engine);
    }
    catch (e){
        return { error: /** @type {any} */ (e), cork: /** @type {any} */ (e).cork };
    }
    throw new Error('the program did not fault');
}

test('a fault raised from translated code is reported as the emulator reports it',
    { timeout: 60000 }, async()=>{
        const exe = buildFaultExe();
        const reference = await fault(exe, 'emulator');
        assert.equal(reference.error.reason, 'guest-fault');
        const hybrid = await fault(exe, 'hybrid');
        assert.equal(hybrid.error.reason, 'guest-fault');
        assert.ok(hybrid.cork.regions >= 1, 'the loop translated');
        assert.ok(hybrid.cork.translatedShare > 0.9, `share ${hybrid.cork.translatedShare}`);
        // The same fault at the same address: the translator left before
        // the instruction and the emulator raised it.
        const at = (/** @type {string} */ message)=>message.match(/0x0040[0-9a-f]{4}/)?.[0];
        assert.equal(at(hybrid.error.message), at(reference.error.message));
        assert.equal(at(hybrid.error.message), '0x00401008');
        assert.equal(hybrid.error.message.replace(/\s+/g, ' '),
            reference.error.message.replace(/\s+/g, ' '));
    });

/**
 * An unpacker's shape: a routine copied into a buffer, a constant in it
 * patched, called; patched again, called again. The result is the sum the
 * two versions add, and the exit code carries it.
 */
function buildUnpackerExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        data: { buffer: new Array(64).fill(0) },
        codeSize: 0x80,
        code: ({ iat, at, code })=>{
            const routine = [
                0xb8, ...u32(0x11),             // mov eax, 0x11   (patched at +1)
                0x01, 0xc3,                     // add ebx, eax
                0xc3,                           // ret
            ];
            const ROUTINE = 0x50;
            const CALLS = 200000;
            const body = [
                0x31, 0xdb,                             //     xor ebx, ebx
                0xbe, ...u32(code(ROUTINE)),            //     mov esi, routine
                0xbf, ...u32(at('buffer')),             //     mov edi, buffer
                0xb9, ...u32(routine.length),           //     mov ecx, len
                0xf3, 0xa4,                             //     rep movsb
                0xb9, ...u32(CALLS),                    //     mov ecx, N
                0xff, 0x15, ...u32(0),                  // L:  call [buffer_ptr]  (patched below)
                0x49,                                   //     dec ecx
                0x75, 0xf7,                             //     jnz L
                0xc6, 0x05, ...u32(at('buffer') + 1), 0x22, //  mov byte [buffer+1], 0x22
                0xb9, ...u32(CALLS),                    //     mov ecx, N
                0xff, 0x15, ...u32(0),                  // M:  call [buffer_ptr]
                0x49,                                   //     dec ecx
                0x75, 0xf7,                             //     jnz M
                0x81, 0xe3, ...u32(0xff),               //     and ebx, 0xff
                0x53,                                   //     push ebx
                0xff, 0x15, ...u32(iat('ExitProcess')), //     call [ExitProcess]
            ];
            // The pointer the calls go through: a dword after the code holding
            // the buffer's address.
            const POINTER = 0x48;
            const pointer = u32(at('buffer'));
            for (let i = 0; i + 5 < body.length; i++)
            {
                if (body[i] === 0xff && body[i + 1] === 0x15 && body[i + 2] === 0
                    && body[i + 3] === 0 && body[i + 4] === 0 && body[i + 5] === 0)
                {
                    body.splice(i + 2, 4, ...u32(code(POINTER)));
                }
            }
            const image = [...body];
            while (image.length < POINTER)
            {
                image.push(0xcc);
            }
            image.push(...pointer);
            while (image.length < ROUTINE)
            {
                image.push(0xcc);
            }
            image.push(...routine);
            return image;
        },
    });
}

test('an unpacker-shaped program: code copied, patched and called gives the emulator\'s result',
    { timeout: 120000 }, async()=>{
        const exe = buildUnpackerExe();
        const reference = await run(exe, 'emulator');
        assert.equal(reference.code, (0x11 * 200000 + 0x22 * 200000) & 0xff);
        const hybrid = await run(exe, 'hybrid');
        assert.equal(hybrid.code, reference.code);
        assert.ok(hybrid.cork.regions >= 1);
        assert.ok(hybrid.cork.invalidations >= 1 || hybrid.cork.exits.stale >= 1,
            `the patch was seen: ${JSON.stringify(hybrid.cork)}`);
        assert.ok(hybrid.cork.translatedShare > 0.5, `share ${hybrid.cork.translatedShare}`);
    });
