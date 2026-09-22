/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, Version 2.0
 * See LICENSE for details
 */

/**
 * A program whose hot code is x87 in the shapes a compiled C program has,
 * under `hybrid` with the translator attached: a function called through
 * `call` with a stack frame and `fld`/`fstp` against `[ebp+disp]`, one with
 * `[esp+disp]`, both returning in the middle of the stack use (the result in
 * ST(0), the caller's store at the return address), and a loop with x87 in
 * the body and an integer compare at its end.
 *
 * The shapes are where the x87 stack tracker meets code it does not reach
 * with a known state: the return address after a `call` is a block of the
 * caller's region whose top the callee decides, so it is compiled for the
 * top the machine has when it comes back -- an entry of its own, keyed by
 * address and top, queued by the untranslated exits that miss it. The whole
 * route then stays in translated code: the share says so, and the `refused`
 * map stays at the few refusals the first formations make while the tops
 * are still being learned, instead of growing with every pass.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { cpuModule } from './layers/cpu/module.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);
// Enough iterations that the warm-up -- two slices of exits while the return
// addresses' tops are still being learned -- is a small part of the run, and
// small enough that the sum stays exact in the single precision the program
// keeps it in (below 2^24).
const ITERATIONS = 150_000;
/** (2*(3+4))^2 per iteration, summed; the exit code is its low byte. */
const EXPECTED = (98 * ITERATIONS) & 0xff;

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {number} value */
const f32 = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, true);
    return [...bytes];
};

const OFF_L = 0x10;
const OFF_F = 0xa0;
const OFF_G = 0xd0;

/**
 * main: fninit; esi = N
 * L:    push [arg2]; push [arg1]; call F
 * RA1:  fstp [tmp]; push [tmp]; call G
 * RA2:  fstp [tmp2]; fld [acc]; fadd [tmp2]; fstp [acc]; add esp,12; dec esi; jnz L
 *       fld [acc]; fistp [out]; exit with [out] & 0xff
 * F:    push ebp; mov ebp,esp; sub esp,8; fld [ebp+8]; fadd [ebp+12];
 *       fstp [ebp-4]; fld [ebp-4]; fmul [ebp-4]; mov esp,ebp; pop ebp; ret
 * G:    fld [esp+4]; fadd [esp+4]; ret
 */
function buildX87Exe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        data: {
            arg1: f32(3), arg2: f32(4), tmp: [0, 0, 0, 0], tmp2: [0, 0, 0, 0],
            acc: [0, 0, 0, 0], out: [0, 0, 0, 0],
        },
        // The data on a page of its own, as a compiler's sections place it:
        // a store into code granules is another subject (2.4's).
        codeSize: 0x1000,
        code: ({ iat, at, code })=>{
            /** @type {number[]} */
            const image = [];
            /** @param {number[]} bytes */
            const emit = bytes=>image.push(...bytes);
            /** @param {number} offset */
            const padTo = offset=>{
                while (image.length < offset)
                {
                    image.push(0x90);
                }
            };
            emit([0xdb, 0xe3]);                        // fninit
            emit([0xbe, ...u32(ITERATIONS)]);          // mov esi, N
            padTo(OFF_L);
            emit([0xff, 0x35, ...u32(at('arg2'))]);    // L: push dword [arg2]
            emit([0xff, 0x35, ...u32(at('arg1'))]);    //    push dword [arg1]
            const callF = image.length;
            emit([0xe8, 0, 0, 0, 0]);                  //    call F
            emit([0xd9, 0x1d, ...u32(at('tmp'))]);     // RA1: fstp dword [tmp]
            emit([0xff, 0x35, ...u32(at('tmp'))]);     //    push dword [tmp]
            const callG = image.length;
            emit([0xe8, 0, 0, 0, 0]);                  //    call G
            emit([0xd9, 0x1d, ...u32(at('tmp2'))]);    // RA2: fstp dword [tmp2]
            emit([0xd9, 0x05, ...u32(at('acc'))]);     //    fld dword [acc]
            emit([0xd8, 0x05, ...u32(at('tmp2'))]);    //    fadd dword [tmp2]
            emit([0xd9, 0x1d, ...u32(at('acc'))]);     //    fstp dword [acc]
            emit([0x83, 0xc4, 0x0c]);                  //    add esp, 12
            emit([0x4e]);                              //    dec esi
            emit([0x75, (OFF_L - (image.length + 2)) & 0xff]); // jnz L
            emit([0xd9, 0x05, ...u32(at('acc'))]);     //    fld dword [acc]
            emit([0xdb, 0x1d, ...u32(at('out'))]);     //    fistp dword [out]
            emit([0xa1, ...u32(at('out'))]);           //    mov eax, [out]
            emit([0x25, 0xff, 0, 0, 0]);               //    and eax, 0xff
            emit([0x50]);                              //    push eax
            emit([0xff, 0x15, ...u32(iat('ExitProcess'))]); // call [ExitProcess]
            padTo(OFF_F);
            emit([0x55]);                              // F: push ebp
            emit([0x89, 0xe5]);                        //    mov ebp, esp
            emit([0x83, 0xec, 0x08]);                  //    sub esp, 8
            emit([0xd9, 0x45, 0x08]);                  //    fld dword [ebp+8]
            emit([0xd8, 0x45, 0x0c]);                  //    fadd dword [ebp+12]
            emit([0xd9, 0x5d, 0xfc]);                  //    fstp dword [ebp-4]
            emit([0xd9, 0x45, 0xfc]);                  //    fld dword [ebp-4]
            emit([0xd8, 0x4d, 0xfc]);                  //    fmul dword [ebp-4]
            emit([0x89, 0xec]);                        //    mov esp, ebp
            emit([0x5d]);                              //    pop ebp
            emit([0xc3]);                              //    ret
            padTo(OFF_G);
            emit([0xd9, 0x44, 0x24, 0x04]);            // G: fld dword [esp+4]
            emit([0xd8, 0x44, 0x24, 0x04]);            //    fadd dword [esp+4]
            emit([0xc3]);                              //    ret
            // The calls' displacements, now that every address is known.
            /** @param {number} from @param {number} to */
            const rel = (from, to)=>code(to) - code(from + 5);
            image.splice(callF + 1, 4, ...u32(rel(callF, OFF_F)));
            image.splice(callG + 1, 4, ...u32(rel(callG, OFF_G)));
            return image;
        },
    });
}

/**
 * @param {Uint8Array} executable @param {'emulator' | 'hybrid'} engine
 * @param {Record<string, unknown>} [config]  more translator settings: a store, a bundle id
 */
async function run(executable, engine, config = {}){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const app = await createApp({
        executable,
        engine,
        cork: { config: { hotThreshold: 100, feed: 'slice', ...config } },
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
    });
    try
    {
        const code = await app.run({ timeoutMs: 60000 });
        const { metrics } = cpuModule.diagnostics();
        return { code, cork: /** @type {any} */ (metrics).cork };
    }
    finally
    {
        await app.dispose();
    }
}

test('x87 in the shapes a compiled C program has translates whole under hybrid',
    { timeout: 120000 }, async()=>{
        const exe = buildX87Exe();
        const reference = await run(exe, 'emulator');
        assert.equal(reference.code, EXPECTED);
        assert.equal(reference.cork, null);
        const hybrid = await run(exe, 'hybrid');
        assert.equal(hybrid.code, EXPECTED, 'the accumulator the x87 route computed');
        const cork = hybrid.cork;
        assert.ok(cork, 'the translator reports');
        // The return addresses, the callees and the loop are entries keyed by
        // address and top: after the few formations that learn them the whole
        // route is translated code.
        assert.ok(cork.translatedShare > 0.9,
            `share ${cork.translatedShare}, exits ${JSON.stringify(cork.exits)}`);
        // The refusals are what the first formations leave while the tops
        // are still unknown; a tracker that does not reach the entry of a
        // region re-forms it every pass and the map grows without bound.
        const refusals = Object.values(/** @type {Record<string, number>} */ (cork.refused));
        const refused = refusals.reduce((sum, times)=>sum + times, 0);
        assert.ok(refused <= 24, `refused ${JSON.stringify(cork.refused)}`);
        assert.ok(cork.exits.untranslated < 15000,
            `untranslated exits ${cork.exits.untranslated}`);
        // The translation milliseconds are the sum of their parts, whatever
        // the parts are: the frame's own figure is read against them.
        assert.equal(cork.translateMs, parts(cork));
    });

/** The translate split's sum. @param {Record<string, number>} cork */
const parts = cork=>cork.formingMs + cork.lookupMs + cork.emitMs + cork.encodeMs
    + cork.storeMs + cork.instantiateMs + cork.publishMs;

test('a second run against one store emits nothing, and the split says where the time goes',
    { timeout: 120000 }, async()=>{
        const { memoryTranslationStore } = await import('../../cork/src/runtime/cache.js');
        const store = memoryTranslationStore();
        const exe = buildX87Exe();
        const cold = await run(exe, 'hybrid', { store, bundleId: 'itest' });
        assert.equal(cold.code, EXPECTED);
        assert.equal(cold.cork.cacheHits, 0);
        assert.ok(cold.cork.cacheMisses >= 5, `misses ${cold.cork.cacheMisses}`);
        assert.ok(cold.cork.emitMs > 0, 'the cold run emits');
        assert.ok(cold.cork.instantiateMs > 0, 'and instantiates');
        assert.equal(cold.cork.translateMs, parts(cold.cork));
        const warm = await run(exe, 'hybrid', { store, bundleId: 'itest' });
        assert.equal(warm.code, EXPECTED);
        assert.equal(warm.cork.cacheMisses, 0, 'every region the store held');
        assert.equal(warm.cork.cacheHits, warm.cork.modules);
        assert.equal(warm.cork.emitMs, 0, 'a hit emits nothing');
        assert.equal(warm.cork.encodeMs, 0, 'and encodes nothing');
        assert.ok(warm.cork.translateMs < cold.cork.translateMs, 'cheaper than emitting');
        assert.equal(warm.cork.translateMs, parts(warm.cork));
        assert.equal(warm.cork.regions, cold.cork.regions, 'the same regions, published again');
        assert.equal(warm.cork.translatedShare, cold.cork.translatedShare);
    });
