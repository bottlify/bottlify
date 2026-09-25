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
import { bridgeModule } from './layers/bridge/module.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);
/** @param {string} name */
const FIXTURE = name=>new URL(`../test/fixtures/${name}`, import.meta.url);
const ITERATIONS = 2_000_000;
const missing = ['v86.wasm', 'libv86.mjs']
    .filter((/** @type {string} */ name)=>!existsSync(new URL(name, PREBUILT)));

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** A loop that calls lstrlenA("abc") `iterations` times and exits with the sum. */
function buildLoopExe(iterations = ITERATIONS){
    return buildExe({
        imports: { 'KERNEL32.dll': ['lstrlenA', 'ExitProcess'] },
        data: { text: [0x61, 0x62, 0x63, 0] },
        codeSize: 0x40,
        code: ({ iat, at })=>[
            0xbe, ...u32(iterations),
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
 * into the entry vector, where `BOUND` sits in its register form (`62 d0`, the
 * low byte of an entry point followed by a register ModRM, exactly what the
 * real route's vector held). The emulator's decoder consumes that instruction
 * and carries on, so cork must too: the program exits 42 on both. This is the
 * path the real-route run stopped on at 0x7000.
 */
function buildVectorReturnExe(){
    return buildExe({
        imports: { 'msvcrt.dll': ['no_such_import'], 'KERNEL32.dll': ['ExitProcess'] },
        data: {},
        codeSize: 0x80,
        code: ({ iat, code })=>{
            const atExit = code(0x40);
            const rel = atExit - 0x7007; // the jmp after `62 d0`, from 0x7002
            const first = ((rel & 0xff) << 24 | 0x00e9d062) >>> 0; // 62 d0 e9 rel0
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
        cork: { config: { feed: 'slice', timings: true } },
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
            trapsHot: /** @type {[string, number][]} */ (
                /** @type {any} */ (bridgeModule.diagnostics().metrics).hot ?? []),
            cork: /** @type {any} */ (metrics).cork };
    }
    catch (e){
        // The translator's report goes with the rejection: the machine is gone
        // once the app is disposed.
        const { metrics } = cpuModule.diagnostics();
        /** @type {any} */ (e).cork = /** @type {any} */ (metrics).cork;
        throw e;
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

for (const name of ['qsort.exe', 'threads.exe', 'session.exe'])
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
            // No turn of the loading phase retired nothing: the host would
            // have forced a step and counted it (`forcedSteps`).
            assert.equal(cork.cork.forcedSteps, 0,
                `a turn retired nothing and was forced: ${cork.cork.forcedSteps}`);
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
                + ` worker ${cork.cork.workerMs.toFixed(0)})`
                + ` traps ${cork.diagnostics.metrics?.trapCrossings},`
                + ` forced ${cork.cork.forcedSteps}`);
            const hot = cork.trapsHot.slice(0, 4)
                .map(([called, count])=>`${called}x${count}`).join(' ');
            console.log(`${name} traps by import: ${hot || '(none)'}`);
            const targets = /** @type {{ address: number, count: number, reason: string }[]} */ (
                cork.cork.exitsByTarget ?? []);
            if (targets.length > 0)
            {
                console.log(`${name} exits by target: `
                    + targets.slice(0, 8).map(row=>`0x${row.address.toString(16)}`
                        + `:${row.reason}x${row.count}`).join(' '));
            }
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
        // E: the translator's cost is a fixed warm-up, not a per-slice toll.
        // The two runs below leave the same regions, so whatever the longer
        // one pays more is the engine thread translating on the slice path
        // after warm-up -- which must be nothing.
        const warm = await run(buildLoopExe(ITERATIONS / 2), 'cork');
        const twice = await run(buildLoopExe(ITERATIONS * 2), 'cork');
        // Same regions and modules on four times the iterations: the
        // translator does nothing on the slice path after warm-up. The
        // translateMs bound is loose only because the wasm engine's own JIT
        // warms in those milliseconds; a per-slice toll would be thousands.
        assert.equal(twice.cork.regions, warm.cork.regions,
            'the longer run forms no further regions: the translator is done at warm-up');
        assert.equal(twice.cork.modules, warm.cork.modules,
            'no further module is emitted or instantiated after warm-up');
        assert.ok(twice.cork.translateMs < 20,
            `translateMs ${twice.cork.translateMs.toFixed(2)} ms for ${ITERATIONS * 2} iterations`);
        console.log(`cork translateMs: ${warm.cork.translateMs.toFixed(2)} ms at`
            + ` ${ITERATIONS / 2} iterations, ${twice.cork.translateMs.toFixed(2)} ms at`
            + ` ${ITERATIONS * 2}, regions ${twice.cork.regions},`
            + ` modules ${twice.cork.modules}`);
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

test('the trap count and the trap log agree with the emulator\'s run of the loop',
    { skip: missing.length > 0 && `missing ${missing.join(', ')}`, timeout: 120000 }, async()=>{
        const exe = buildLoopExe();
        const reference = await run(exe, 'emulator');
        const cork = await run(exe, 'cork');
        assert.equal(cork.code, reference.code);
        assert.equal(cork.diagnostics.metrics?.trapCrossings,
            reference.diagnostics.metrics?.trapCrossings,
            'the same number of crossings');
        assert.deepEqual(cork.trapsHot, reference.trapsHot,
            'the same imports trapped, the same number of times');
    });

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
 * @param {Uint8Array} executable @param {'emulator' | 'cork'} engine
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

test('a fault under cork is reported as the emulator reports it',
    { skip: missing.length > 0 && `missing ${missing.join(', ')}`, timeout: 120000 }, async()=>{
        const exe = buildFaultExe();
        const reference = await fault(exe, 'emulator');
        assert.equal(reference.error.reason, 'guest-fault');
        const cork = await fault(exe, 'cork');
        assert.equal(cork.error.reason, 'guest-fault');
        assert.ok(cork.cork.regions >= 1, 'the loop translated');
        assert.ok(cork.cork.translatedShare > 0.9, `share ${cork.cork.translatedShare}`);
        // The same fault at the same address: transcribed code left before the
        // instruction and cork's own fault path built the record.
        const at = (/** @type {string} */ message)=>message.match(/0x0040[0-9a-f]{4}/)?.[0];
        assert.equal(at(cork.error.message), at(reference.error.message));
        assert.equal(at(cork.error.message), '0x00401008');
        assert.equal(cork.error.message.replace(/\s+/g, ' '),
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

test('an unpacker-shaped program runs under cork',
    { skip: missing.length > 0 && `missing ${missing.join(', ')}`, timeout: 180000 }, async()=>{
        const exe = buildUnpackerExe();
        const reference = await run(exe, 'emulator');
        assert.equal(reference.code, (0x11 * 200000 + 0x22 * 200000) & 0xff);
        const cork = await run(exe, 'cork');
        assert.equal(cork.code, reference.code);
        assert.equal(cork.output, reference.output);
        assert.ok(cork.cork.regions >= 1);
        assert.ok(cork.cork.invalidations >= 1 || cork.cork.exits.stale >= 1,
            `the patch was seen: ${JSON.stringify(cork.cork)}`);
    });

test('a call area switched on mid-run is traced from the next call on',
    { timeout: 60000 }, async()=>{
    // The journal's answer for a call's area is kept per name until a level
    // moves; switching tracing on while the program runs must reach the very
    // next call under that name.
        const exe = buildExe({
            imports: { 'KERNEL32.dll': ['GetCurrentThreadId', 'ExitProcess'] },
            data: {},
            codeSize: 0x40,
            // mov esi, 5; L: call [GetCurrentThreadId]; dec esi; jnz L; push 0; call [ExitProcess]
            code: ({ iat })=>[0xbe, ...u32(5),
                0xff, 0x15, ...u32(iat('GetCurrentThreadId')), 0x4e, 0x75, 0xf7,
                0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))],
        });
        /** @type {any} */
        let app = null;
        let calls = 0;
        app = await createApp({
            executable: exe,
            engine: 'cork',
            onCall: (/** @type {any} */ call)=>{
                if (call.name === 'KERNEL32.dll!GetCurrentThreadId' && ++calls === 1)
                {
                    for (const area of app.log.areas())
                    {
                        app.log.setLevel(area, 'trace');
                    }
                }
            },
        });
        try
        {
            await app.run({ timeoutMs: 30000 });
            const traced = app.log.recent(1000)
                .filter((/** @type {any} */ record)=>/GetCurrentThreadId/.test(record.text));
            assert.equal(calls, 5);
            assert.equal(traced.length, 4,
                'the four calls after it, not the one that switched it on');
        }
        finally
        {
            await app.dispose();
        }
    });
