/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Whole programs under `cork`: the interpreter runs the cold code, the hotness
 * it counts forms regions at the threshold, and the program ends as it ends on
 * cork's instruction model alone -- the JavaScript interpreter over `ir.js`,
 * with nothing translated and no wasm tier. The fixtures -- `hello`, a calling
 * loop (`imports`), `qsort` (callbacks) and the threaded fixture -- prove the
 * scheduler, the loader and the trap channel agree with translated code as
 * they do with the model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import { threadCpuMs } from '../../../tools/cpu-time.mjs';
import { assemble } from './layers/win32/msvcrt/guest-code.js';

/**
 * A layer's report from the app's own graph: every graph has module objects of
 * its own, so the exported module is not the one the app's machine was made by.
 *
 * @param {any} app @param {string} name
 * @returns {any}
 */
const layerOf = (app, name)=>app.diagnostics()
    .find((/** @type {any} */ layer)=>layer.name === name);

/** @param {string} name */
const FIXTURE = name=>new URL(`../test/fixtures/${name}`, import.meta.url);
/**
 * Calls the loop makes into the host: enough that the warm-up is a small part
 * of the run and the longer run four times the shorter, a quarter million --
 * at two million the test took 68 s of an otherwise quiet machine.
 */
const ITERATIONS = 250_000;
/** Cork with nothing translated and no wasm tier: the reference a run is judged against. */
const MODEL = { translate: false, wasmInterpreter: false };

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * A loop that calls lstrcmpA("abc", "ab") `iterations` times and exits with the
 * sum of its answers, 1 each: an import that crosses into the host every time.
 */
function buildLoopExe(iterations = ITERATIONS){
    return buildExe({
        imports: { 'KERNEL32.dll': ['lstrcmpA', 'ExitProcess'] },
        data: { text: [0x61, 0x62, 0x63, 0], shorter: [0x61, 0x62, 0] },
        codeSize: 0x40,
        code: ({ iat, at })=>[
            0xbe, ...u32(iterations),
            0x31, 0xff,
            0x68, ...u32(at('shorter')),
            0x68, ...u32(at('text')),
            0xff, 0x15, ...u32(iat('lstrcmpA')),
            0x01, 0xc7,
            0x4e,
            0x75, 0xeb,
            0x81, 0xe7, ...u32(0xff),
            0x57,
            0xff, 0x15, ...u32(iat('ExitProcess')),
            // Never reached: the end of the code is not left to whatever
            // follows it.
            0xf4, // hlt
        ],
    });
}

/**
 * Calls an import nothing claims -- which returns zero through the stubs so a
 * callback or an unresolved import's return is the shape -- and then jumps to
 * `BOUND` in its register form (`62 d0`, the low byte of an entry point
 * followed by a register ModRM, exactly what a real run once found where it
 * returned into the entry vector). A processor's decoder consumes that
 * instruction and carries on, so cork must too: the program exits 42.
 * The bytes sit in the image's data, since the entry vector is in the 64 KiB
 * a process never maps.
 */
function buildVectorReturnExe(){
    return buildExe({
        imports: { 'msvcrt.dll': ['no_such_import'], 'KERNEL32.dll': ['ExitProcess'] },
        data: { vector: [0, 0, 0, 0, 0, 0, 0, 0] },
        codeSize: 0x80,
        code: ({ iat, at, code })=>{
            const vector = at('vector');
            const atExit = code(0x40);
            const rel = atExit - (vector + 7); // the jmp after `62 d0`
            const first = ((rel & 0xff) << 24 | 0x00e9d062) >>> 0; // 62 d0 e9 rel0
            const second = rel >>> 8;
            const atJmp = code(26);
            return [
                0xc7, 0x05, ...u32(vector), ...u32(first), // mov dword [vector], ...
                0xc7, 0x05, ...u32(vector + 4), ...u32(second),
                0xff, 0x15, ...u32(iat('no_such_import')), // call the unresolved import
                0xe9, ...u32(vector - (atJmp + 5)), // jmp vector
                ...new Array(0x40 - 31).fill(0x90),
                0x6a, 0x2a, 0xff, 0x15, ...u32(iat('ExitProcess')), // exit 42
                ...new Array(20).fill(0x90),
            ];
        },
    });
}

/**
 * @param {Uint8Array} executable
 * @param {boolean} [translated]  false runs the model alone (`MODEL`).
 */
async function run(executable, translated = true){
    const app = await createApp({
        executable,
        cork: { config: { feed: 'slice', timings: true, ...translated ? {} : MODEL } },
    });
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));
    try
    {
        const began = performance.now();
        const cpuBegan = threadCpuMs();
        const code = await app.run({ timeoutMs: 90_000 });
        const ms = performance.now() - began;
        // A program of one thread translated inline: the run is this thread's work.
        const cpuMs = threadCpuMs() - cpuBegan;
        const { metrics } = layerOf(app, 'cpu');
        return { code, output: output.join(''), diagnostics: layerOf(app, 'cpu'), ms, cpuMs,
            instructions: /** @type {any} */ (metrics).instructions,
            trapsHot: /** @type {[string, number][]} */ (
                /** @type {any} */ (layerOf(app, 'bridge').metrics).hot ?? []),
            cork: /** @type {any} */ (metrics).cork };
    }
    catch (e){
        // The translator's report goes with the rejection: the machine is gone
        // once the app is disposed.
        const { metrics } = layerOf(app, 'cpu');
        /** @type {any} */ (e).cork = /** @type {any} */ (metrics).cork;
        throw e;
    }
    finally
    {
        await app.dispose();
    }
}

test('hello ends translated as it ends on the model',
    async()=>{
        const exe = new Uint8Array(await readFile(FIXTURE('hello.exe')));
        const reference = await run(exe, false);
        const cork = await run(exe);
        assert.equal(cork.code, reference.code);
        assert.equal(cork.output, reference.output);
    });

for (const name of ['qsort.exe', 'threads.exe', 'session.exe'])
{
    test(`${name} ends translated as it ends on the model`,
        async()=>{
            const exe = new Uint8Array(await readFile(FIXTURE(name)));
            const reference = await run(exe, false);
            const cork = await run(exe);
            assert.equal(cork.code, reference.code);
            assert.equal(cork.output, reference.output);
            assert.ok(cork.cork.regions >= 1,
                `no region formed: ${JSON.stringify(cork.cork)}`);
            // No turn of the loading phase retired nothing: the host would
            // have forced a step and counted it (`forcedSteps`).
            assert.equal(cork.cork.forcedSteps, 0,
                `a turn retired nothing and was forced: ${cork.cork.forcedSteps}`);
            // The loading phase: how cork runs the program against the
            // model, and where the translation time went. These programs are
            // short and boot-dominated, so the instruction counts and the split
            // say more than a rate rounded to zero.
            console.log(`${name}: share ${cork.cork.translatedShare.toFixed(3)},`
                + ` regions ${cork.cork.regions},`
                + ` cork ${cork.instructions} instr in ${cork.ms.toFixed(1)} ms vs`
                + ` model ${reference.instructions} in ${reference.ms.toFixed(1)} ms,`
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

test('BOUND in its register form runs translated as on the model',
    async()=>{
        const exe = buildVectorReturnExe();
        const reference = await run(exe, false);
        const cork = await run(exe);
        assert.equal(reference.code, 42, 'the model ran past BOUND');
        assert.equal(cork.code, reference.code,
            `translated code stopped where the model carried on: ${JSON.stringify(cork.cork)}`);
        assert.equal(cork.output, reference.output);
    });

test('a loop calling an import runs and translates under cork',
    async()=>{
        const exe = buildLoopExe();
        const reference = await run(exe, false);
        assert.equal(reference.code, ITERATIONS & 0xff);
        const cork = await run(exe);
        assert.equal(cork.code, reference.code);
        assert.equal(cork.output, reference.output);
        assert.ok(cork.cork.regions >= 1, `no region formed: ${JSON.stringify(cork.cork)}`);
        assert.ok(cork.cork.translatedShare > 0.9,
            `the hot loop translated: share ${cork.cork.translatedShare},`
            + ` exits ${JSON.stringify(cork.cork.exits)}`);
        // The loop traps an import every iteration, so its rate is the trap
        // channel's cost as much as the executor's; the compute loop below is
        // where the executor shows.
        const corkRate = cork.instructions / cork.cpuMs / 1000;
        const modelRate = reference.instructions / reference.cpuMs / 1000;
        console.log(`cork loop: share ${cork.cork.translatedShare.toFixed(2)},`
            + ` regions ${cork.cork.regions},`
            + ` cork ${corkRate.toFixed(0)} M/s vs model ${modelRate.toFixed(0)} M/s of processor time`);
        // E: the translator's cost is a fixed warm-up, not a per-slice toll.
        // The two runs below leave the same regions, so whatever the longer
        // one pays more is the engine thread translating on the slice path
        // after warm-up -- which must be nothing.
        const warm = await run(buildLoopExe(ITERATIONS / 2));
        const twice = await run(buildLoopExe(ITERATIONS * 2));
        // Same regions and modules on four times the iterations: the
        // translator does nothing on the slice path after warm-up. Held by
        // every count the translator keeps, not by its time against the run's:
        // a machine others load stretches the two unevenly, the warm-up's
        // moments by more than the run's or less.
        assert.equal(twice.cork.regions, warm.cork.regions,
            'the longer run forms no further regions: the translator is done at warm-up');
        assert.equal(twice.cork.modules, warm.cork.modules,
            'no further module is emitted or instantiated after warm-up');
        /**
         * The translator's counts: what it did, not how long it took or what ran.
         * @param {any} counts
         */
        const work = counts=>Object.fromEntries(Object.entries(counts).filter(([name, value])=>
            typeof value === 'number' && !/Ms$|Share$|^retired$/.test(name)));
        assert.deepEqual(work(twice.cork), work(warm.cork),
            'nothing the translator counts grows with the iterations');
        console.log(`cork translateMs: ${warm.cork.translateMs.toFixed(2)} ms at`
            + ` ${ITERATIONS / 2} iterations, ${twice.cork.translateMs.toFixed(2)} ms at`
            + ` ${ITERATIONS * 2} (runs of ${warm.ms.toFixed(0)} and ${twice.ms.toFixed(0)} ms),`
            + ` regions ${twice.cork.regions},`
            + ` modules ${twice.cork.modules}`);
    });

/**
 * Calls a function of its own a thousand times, rewrites the function's
 * immediate through WriteProcessMemory -- a host write into a page of
 * translated code -- calls it a thousand times more, and exits with the sum:
 * 1000 * 1 + 1000 * 7.
 */
function buildRewriteExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['WriteProcessMemory', 'ExitProcess'] },
        data: { seven: u32(7) },
        codeSize: 0x120,
        code: ({ iat, at, code })=>{
            /** @type {(number[] | string | { jump: number[], to: string, short?: boolean })[]} */
            const main = [
                [0xbe, ...u32(1000), 0x31, 0xff],                        // esi = 1000; edi = 0
                'first',
                { jump: [0xe8], to: 'F' }, [0x01, 0xc7, 0x4e],           // call F; add edi, eax
                { jump: [0x75], to: 'first', short: true },              // dec esi; jnz
                [0x6a, 0x00, 0x6a, 0x04, 0x68, ...u32(at('seven'))],     // WriteProcessMemory(-1,
                [0x68, ...u32(code(0x101)), 0x6a, 0xff],                 //   F + 1, &seven, 4, 0)
                [0xff, 0x15, ...u32(iat('WriteProcessMemory'))],
                [0xbe, ...u32(1000)],
                'second',
                { jump: [0xe8], to: 'F' }, [0x01, 0xc7, 0x4e],
                { jump: [0x75], to: 'second', short: true },
                [0x57, 0xff, 0x15, ...u32(iat('ExitProcess')), 0xf4],    // exit edi
            ];
            const length = assemble([...main, 'F']).length;
            return [...assemble([...main, new Array(0x100 - length).fill(0x90), 'F',
                [0xb8, ...u32(1), 0xc3]])];                              // F: mov eax, 1; ret
        },
    });
}

test('a program that rewrites its own translated code through the host runs what it wrote',
    async()=>{
        const exe = buildRewriteExe();
        const reference = await run(exe, false);
        assert.equal(reference.code, 8000);
        const cork = await run(exe);
        assert.equal(cork.code, reference.code);
        assert.ok(cork.cork.regions >= 1, `no region formed: ${JSON.stringify(cork.cork)}`);
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
                0xf4, // hlt, never reached: as buildLoopExe's
                ...new Array(20).fill(0x90),
            ];
        },
    });
}

test('a cold loop becomes a region on its second visit',
    async()=>{
        // Eight iterations are more than the default threshold of two and far
        // fewer than the sampler's old two thousand: before the translation
        // policy was lowered for cork this loop stayed interpreted and formed
        // no region at all.
        const exe = buildComputeExe(8);
        const cork = await run(exe);
        assert.ok(cork.cork.regions >= 1,
            `the cold loop never became a region: ${JSON.stringify(cork.cork)}`);
    });

test('a compute loop runs translated, and faster than the model',
    async()=>{
        const exe = buildComputeExe();
        const reference = await run(exe, false);
        const cork = await run(exe);
        assert.equal(cork.code, reference.code);
        assert.ok(cork.cork.translatedShare > 0.9,
            `the loop translated: share ${cork.cork.translatedShare}`);
        // Rates of this thread's processor time: two wall times taken a run
        // apart compare the machine's load at the two moments as much as the
        // code.
        const corkRate = cork.instructions / cork.cpuMs / 1000;
        const modelRate = reference.instructions / reference.cpuMs / 1000;
        console.log(`cork compute: share ${cork.cork.translatedShare.toFixed(2)},`
            + ` regions ${cork.cork.regions},`
            + ` cork ${corkRate.toFixed(0)} M/s vs model ${modelRate.toFixed(0)} M/s of processor time`);
        assert.ok(corkRate > modelRate,
            `translated code ran the compute loop at ${corkRate.toFixed(1)} M/s against the`
            + ` model's ${modelRate.toFixed(1)} M/s, of this thread's processor time`);
    });

test('the trap count and the trap log agree with the model\'s run of the loop',
    async()=>{
        const exe = buildLoopExe();
        const reference = await run(exe, false);
        const cork = await run(exe);
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
 * @param {Uint8Array} executable @param {boolean} [translated]
 */
async function fault(executable, translated = true){
    try
    {
        await run(executable, translated);
    }
    catch (e){
        return { error: /** @type {any} */ (e), cork: /** @type {any} */ (e).cork };
    }
    throw new Error('the program did not fault');
}

test('a fault in translated code is reported as the model reports it',
    async()=>{
        const exe = buildFaultExe();
        const reference = await fault(exe, false);
        assert.equal(reference.error.reason, 'guest-fault');
        const cork = await fault(exe);
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
    async()=>{
        const exe = buildUnpackerExe();
        const reference = await run(exe, false);
        assert.equal(reference.code, (0x11 * 200000 + 0x22 * 200000) & 0xff);
        const cork = await run(exe);
        assert.equal(cork.code, reference.code);
        assert.equal(cork.output, reference.output);
        assert.ok(cork.cork.regions >= 1);
        assert.ok(cork.cork.invalidations >= 1 || cork.cork.exits.stale >= 1,
            `the patch was seen: ${JSON.stringify(cork.cork)}`);
    });

test('with no sink of the caller\'s own, a traced area\'s calls reach the journal and an '
    + 'untraced one\'s do not', async()=>{
    // The bridge asks once a function whether the engine's own sink keeps its
    // calls, and hands it those alone. GetCurrentProcessId is a host call;
    // GetCurrentThreadId is answered in guest code and never reaches it.
    const exe = buildExe({
        imports: {
            'KERNEL32.dll': ['GetCurrentProcessId', 'ExitProcess'],
            'USER32.dll': ['GetSystemMetrics'],
        },
        data: {},
        codeSize: 0x40,
        // mov esi, 3; L: call [GetCurrentProcessId]; push 0; call [GetSystemMetrics];
        // dec esi; jnz L; push 0; call [ExitProcess]
        code: ({ iat })=>[0xbe, ...u32(3),
            0xff, 0x15, ...u32(iat('GetCurrentProcessId')),
            0x6a, 0x00, 0xff, 0x15, ...u32(iat('GetSystemMetrics')), 0x4e, 0x75, 0xef,
            0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))],
    });
    const app = await createApp({ executable: exe });
    try
    {
        app.log.setLevel('call.cpu', 'trace');
        await app.run({ timeoutMs: 90_000 });
        /** @type {string[]} */
        const texts = app.log.recent(1000).map((/** @type {any} */ record)=>record.text);
        assert.equal(texts.filter(text=>/GetCurrentProcessId/.test(text)).length, 3,
            'every call of the traced area');
        assert.equal(texts.filter(text=>/GetSystemMetrics/.test(text)).length, 0,
            'none of the other');
    }
    finally
    {
        await app.dispose();
    }
});

test('a call area switched on mid-run is traced from the next call on',
    async()=>{
    // The journal's answer for a call's area is kept per name until a level
    // moves; switching tracing on while the program runs must reach the very
    // next call under that name.
        const exe = buildExe({
            imports: { 'KERNEL32.dll': ['GetCurrentProcessId', 'ExitProcess'] },
            data: {},
            codeSize: 0x40,
            // mov esi, 5; L: call [GetCurrentProcessId]; dec esi; jnz L; push 0; call [ExitProcess]
            code: ({ iat })=>[0xbe, ...u32(5),
                0xff, 0x15, ...u32(iat('GetCurrentProcessId')), 0x4e, 0x75, 0xf7,
                0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))],
        });
        /** @type {any} */
        let app = null;
        let calls = 0;
        app = await createApp({
            executable: exe,
            onCall: (/** @type {any} */ call)=>{
                if (call.name === 'KERNEL32.dll!GetCurrentProcessId' && ++calls === 1)
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
            await app.run({ timeoutMs: 90_000 });
            const traced = app.log.recent(1000)
                .filter((/** @type {any} */ record)=>/GetCurrentProcessId/.test(record.text));
            assert.equal(calls, 5);
            assert.equal(traced.length, 4,
                'the four calls after it, not the one that switched it on');
        }
        finally
        {
            await app.dispose();
        }
    });

test('a program\'s calls to the engine\'s own msvcrt memset and strlen are formed as their'
    + ' operations, and answer as the routines do', async()=>{
    // 1000 times: memset(buffer, 0x41 + (i & 7), 100); then strlen(buffer) as the exit code.
    const exe = buildExe({
        imports: { 'msvcrt.dll': ['memset', 'strlen'], 'KERNEL32.dll': ['ExitProcess'] },
        data: { buffer: new Array(128).fill(0) },
        codeSize: 0x60,
        code: ({ iat, at })=>[
            0xbe, ...u32(1000),                                   // mov esi, 1000
            0x89, 0xf0, 0x83, 0xe0, 0x07, 0x83, 0xc0, 0x41,       // eax = 0x41 + (esi & 7)
            0x6a, 100, 0x50, 0x68, ...u32(at('buffer')),          // push 100; push eax; push buf
            0xff, 0x15, ...u32(iat('memset')),                    // call [memset]
            0x83, 0xc4, 12,                                       // add esp, 12
            0x4e, 0x75, 0xe4,                                     // dec esi; jnz
            0x68, ...u32(at('buffer')),
            0xff, 0x15, ...u32(iat('strlen')),                    // call [strlen]
            0x83, 0xc4, 4,
            0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),         // ExitProcess(strlen)
            0xf4,
        ],
    });
    const cork = await run(exe);
    assert.equal(cork.code, 100);
    const formed = /** @type {Record<string, number>} */ (cork.cork.crtFormed ?? {});
    assert.ok((formed.memset ?? 0) >= 1 && (formed.strlen ?? 0) >= 1,
        `formed: ${JSON.stringify(formed)}`);
});

test('a 64-bit program\'s calls to the engine\'s own msvcrt memset and strlen through its import'
    + ' slots are formed as their operations, and answer as the routines do', async()=>{
    const exe = buildExe({
        bits: 64,
        imports: { 'msvcrt.dll': ['memset', 'strlen'], 'KERNEL32.dll': ['ExitProcess'] },
        data: { buffer: new Array(128).fill(0) },
        codeSize: 0x80,
        code: ({ iat, at, code })=>{
            /** @type {number[]} */
            const out = [];
            /** A rip-relative displacement to `target` from the end of an instruction `rest`
             * bytes past here. @param {number} target @param {number} rest */
            const rip = (target, rest)=>u32((target - code(out.length + rest)) >>> 0);
            out.push(0x48, 0x83, 0xec, 0x28);                         // sub rsp, 40
            out.push(0xbb, ...u32(1000));                             // mov ebx, 1000
            const loop = out.length;
            out.push(0x48, 0x8d, 0x0d, ...rip(at('buffer'), 7));      // lea rcx, [buffer]
            out.push(0x89, 0xda, 0x83, 0xe2, 0x07, 0x83, 0xc2, 0x41); // edx = 0x41 + (ebx & 7)
            out.push(0x41, 0xb8, ...u32(100));                        // mov r8d, 100
            out.push(0xff, 0x15, ...rip(iat('memset'), 6));           // call [memset]
            out.push(0xff, 0xcb, 0x75, (loop - (out.length + 4)) & 0xff);  // dec ebx; jnz
            out.push(0x48, 0x8d, 0x0d, ...rip(at('buffer'), 7));
            out.push(0xff, 0x15, ...rip(iat('strlen'), 6));           // call [strlen]
            out.push(0x89, 0xc1);                                     // mov ecx, eax
            out.push(0xff, 0x15, ...rip(iat('ExitProcess'), 6), 0xf4);
            return out;
        },
    });
    const cork = await run(exe);
    assert.equal(cork.code, 100);
    const formed = /** @type {Record<string, number>} */ (cork.cork.crtFormed ?? {});
    assert.ok((formed.memset ?? 0) >= 1 && (formed.strlen ?? 0) >= 1,
        `formed: ${JSON.stringify(formed)}`);
});

test('a 64-bit program\'s msvcrt sin, atan2, acos and pow run as guest code, crossing nothing',
    async()=>{
        // xmm0 = sin(0.5) + atan2(0.25, 2) + acos(0.125) + pow(2, 0.25); its low dword the exit
        // code.
        const exe = buildExe({
            bits: 64,
            imports: { 'msvcrt.dll': ['sin', 'atan2', 'acos', 'pow'],
                'KERNEL32.dll': ['ExitProcess'] },
            data: { half: [...new Uint8Array(new Float64Array([0.5]).buffer)],
                quarter: [...new Uint8Array(new Float64Array([0.25]).buffer)],
                two: [...new Uint8Array(new Float64Array([2]).buffer)],
                eighth: [...new Uint8Array(new Float64Array([0.125]).buffer)],
                sum: new Array(8).fill(0) },
            codeSize: 0xa0,
            code: ({ iat, at, code })=>{
                /** @type {number[]} */
                const out = [];
                const rip = (/** @type {number} */ target, /** @type {number} */ rest)=>
                    u32((target - code(out.length + rest)) >>> 0);
                out.push(0x48, 0x83, 0xec, 0x28);                              // sub rsp, 40
                out.push(0xf2, 0x0f, 0x10, 0x05, ...rip(at('half'), 8));       // movsd xmm0, [half]
                out.push(0xff, 0x15, ...rip(iat('sin'), 6));
                out.push(0xf2, 0x0f, 0x11, 0x05, ...rip(at('sum'), 8));        // movsd [sum], xmm0
                out.push(0xf2, 0x0f, 0x10, 0x05, ...rip(at('quarter'), 8));
                out.push(0xf2, 0x0f, 0x10, 0x0d, ...rip(at('two'), 8));        // movsd xmm1, [two]
                out.push(0xff, 0x15, ...rip(iat('atan2'), 6));
                out.push(0xf2, 0x0f, 0x58, 0x05, ...rip(at('sum'), 8));        // addsd xmm0, [sum]
                out.push(0xf2, 0x0f, 0x11, 0x05, ...rip(at('sum'), 8));
                out.push(0xf2, 0x0f, 0x10, 0x05, ...rip(at('eighth'), 8));
                out.push(0xff, 0x15, ...rip(iat('acos'), 6));
                out.push(0xf2, 0x0f, 0x58, 0x05, ...rip(at('sum'), 8));
                out.push(0xf2, 0x0f, 0x11, 0x05, ...rip(at('sum'), 8));
                out.push(0xf2, 0x0f, 0x10, 0x05, ...rip(at('two'), 8));
                out.push(0xf2, 0x0f, 0x10, 0x0d, ...rip(at('quarter'), 8)); // xmm1
                out.push(0xff, 0x15, ...rip(iat('pow'), 6));
                out.push(0xf2, 0x0f, 0x58, 0x05, ...rip(at('sum'), 8));
                out.push(0x66, 0x48, 0x0f, 0x7e, 0xc1);                        // movq rcx, xmm0
                out.push(0xff, 0x15, ...rip(iat('ExitProcess'), 6), 0xf4);
                return out;
            },
        });
        const cork = await run(exe);
        const want = new Uint32Array(new Float64Array([Math.sin(0.5) + Math.atan2(0.25, 2)
            + Math.acos(0.125) + 2 ** 0.25]).buffer)[0];
        assert.equal(cork.code >>> 0, want);
        const hosted = cork.trapsHot.map(([name])=>name).filter(name=>/sin|atan2|acos|pow/.test(name));
        assert.deepEqual(hosted, [], 'none of them crossed to the host');
    });

test('a 64-bit program\'s msvcrt sinf, atan2f, sqrtf and powf run as guest code, crossing nothing',
    async()=>{
        // xmm0 = sinf(0.5f) + atan2f(0.25f, 2f) + sqrtf(2f) + powf(2f, 0.25f), a float; its bits
        // the exit code.
        const f32 = (/** @type {number} */ x)=>[...new Uint8Array(new Float32Array([x]).buffer)];
        const exe = buildExe({
            bits: 64,
            imports: { 'msvcrt.dll': ['sinf', 'atan2f', 'sqrtf', 'powf'],
                'KERNEL32.dll': ['ExitProcess'] },
            data: { half: f32(0.5), quarter: f32(0.25), two: f32(2), sum: new Array(4).fill(0) },
            codeSize: 0xa0,
            code: ({ iat, at, code })=>{
                /** @type {number[]} */
                const out = [];
                const rip = (/** @type {number} */ target, /** @type {number} */ rest)=>
                    u32((target - code(out.length + rest)) >>> 0);
                out.push(0x48, 0x83, 0xec, 0x28);                              // sub rsp, 40
                out.push(0xf3, 0x0f, 0x10, 0x05, ...rip(at('half'), 8));       // movss xmm0, [half]
                out.push(0xff, 0x15, ...rip(iat('sinf'), 6));
                out.push(0xf3, 0x0f, 0x11, 0x05, ...rip(at('sum'), 8));        // movss [sum], xmm0
                out.push(0xf3, 0x0f, 0x10, 0x05, ...rip(at('quarter'), 8));
                out.push(0xf3, 0x0f, 0x10, 0x0d, ...rip(at('two'), 8));        // movss xmm1, [two]
                out.push(0xff, 0x15, ...rip(iat('atan2f'), 6));
                out.push(0xf3, 0x0f, 0x58, 0x05, ...rip(at('sum'), 8));        // addss xmm0, [sum]
                out.push(0xf3, 0x0f, 0x11, 0x05, ...rip(at('sum'), 8));
                out.push(0xf3, 0x0f, 0x10, 0x05, ...rip(at('two'), 8));
                out.push(0xff, 0x15, ...rip(iat('sqrtf'), 6));
                out.push(0xf3, 0x0f, 0x58, 0x05, ...rip(at('sum'), 8));
                out.push(0xf3, 0x0f, 0x11, 0x05, ...rip(at('sum'), 8));
                out.push(0xf3, 0x0f, 0x10, 0x05, ...rip(at('two'), 8));
                out.push(0xf3, 0x0f, 0x10, 0x0d, ...rip(at('quarter'), 8)); // xmm1
                out.push(0xff, 0x15, ...rip(iat('powf'), 6));
                out.push(0xf3, 0x0f, 0x58, 0x05, ...rip(at('sum'), 8));
                out.push(0x66, 0x0f, 0x7e, 0xc1);                              // movd ecx, xmm0
                out.push(0xff, 0x15, ...rip(iat('ExitProcess'), 6), 0xf4);
                return out;
            },
        });
        const cork = await run(exe);
        const sum = Math.fround(Math.fround(Math.fround(Math.sin(0.5))
            + Math.fround(Math.atan2(0.25, 2))) + Math.fround(Math.sqrt(2)));
        const total = Math.fround(sum + Math.fround(2 ** 0.25));
        assert.equal(cork.code >>> 0, new Uint32Array(new Float32Array([total]).buffer)[0]);
        const hosted = cork.trapsHot.map(([name])=>name)
            .filter(name=>/sinf|atan2f|sqrtf|powf/.test(name));
        assert.deepEqual(hosted, [], 'none of them crossed to the host');
    });

test('a 64-bit program\'s msvcrt sprintf and _snprintf run as guest code, crossing nothing',
    async()=>{
        // sprintf(buffer, "%d|%-4s|%5x|%c|%u", -42, "ab", 255, 'Z', 7) and _snprintf of the
        // same into 6 bytes; the first held to its text by memcmp; the exit code the answers.
        const text = (/** @type {string} */ value)=>[...value].map(c=>c.charCodeAt(0));
        const exe = buildExe({
            bits: 64,
            imports: { 'msvcrt.dll': ['sprintf', '_snprintf', 'memcmp'],
                'KERNEL32.dll': ['ExitProcess'] },
            data: { format: [...text('%d|%-4s|%5x|%c|%u'), 0], word: [...text('ab'), 0],
                want: [...text('-42|ab  |   ff|Z|7'), 0], buffer: new Array(32).fill(0x55) },
            codeSize: 0x100,
            code: ({ iat, at, code })=>{
                /** @type {number[]} */
                const out = [];
                const rip = (/** @type {number} */ target, /** @type {number} */ rest)=>
                    u32((target - code(out.length + rest)) >>> 0);
                out.push(0x53);                                            // push rbx
                out.push(0x48, 0x83, 0xec, 0x40);                          // sub rsp, 64
                // -42 and "ab" in R8 and R9, 255, 'Z' and 7 past the home space.
                out.push(0x48, 0xc7, 0x44, 0x24, 0x20, 255, 0, 0, 0);      // [rsp+32] = 255
                out.push(0x48, 0xc7, 0x44, 0x24, 0x28, 0x5a, 0, 0, 0);     // [rsp+40] = 'Z'
                out.push(0x48, 0xc7, 0x44, 0x24, 0x30, 7, 0, 0, 0);        // [rsp+48] = 7
                out.push(0x48, 0x8d, 0x0d, ...rip(at('buffer'), 7));       // lea rcx, buffer
                out.push(0x48, 0x8d, 0x15, ...rip(at('format'), 7));       // lea rdx, format
                out.push(0x49, 0xc7, 0xc0, ...u32(-42 >>> 0));             // mov r8, -42
                out.push(0x4c, 0x8d, 0x0d, ...rip(at('word'), 7));         // lea r9, word
                out.push(0xff, 0x15, ...rip(iat('sprintf'), 6));
                out.push(0x89, 0xc3);                                      // mov ebx, eax
                out.push(0x48, 0x8d, 0x0d, ...rip(at('buffer'), 7));
                out.push(0x48, 0x8d, 0x15, ...rip(at('want'), 7));
                out.push(0x41, 0xb8, ...u32(19));                          // the text and its 0
                out.push(0xff, 0x15, ...rip(iat('memcmp'), 6));
                out.push(0xc1, 0xe0, 0x10, 0x01, 0xc3);                    // ebx += eax << 16
                // _snprintf(buffer, 6, format, -42, "ab", ...): six bytes, no terminator, -1;
                // -42 in R9, the rest past the home space.
                out.push(0x48, 0x8d, 0x05, ...rip(at('word'), 7));         // lea rax, word
                out.push(0x48, 0x89, 0x44, 0x24, 0x20);                    // mov [rsp+32], rax
                out.push(0x48, 0xc7, 0x44, 0x24, 0x28, 255, 0, 0, 0);
                out.push(0x48, 0xc7, 0x44, 0x24, 0x30, 0x5a, 0, 0, 0);
                out.push(0x48, 0xc7, 0x44, 0x24, 0x38, 7, 0, 0, 0);
                out.push(0x48, 0x8d, 0x0d, ...rip(at('buffer'), 7));
                out.push(0xba, ...u32(6));                                 // mov edx, 6
                out.push(0x4c, 0x8d, 0x05, ...rip(at('format'), 7));       // lea r8, format
                out.push(0x49, 0xc7, 0xc1, ...u32(-42 >>> 0));             // mov r9, -42
                out.push(0xff, 0x15, ...rip(iat('_snprintf'), 6));
                out.push(0xc1, 0xe0, 0x08, 0x01, 0xc3);                    // ebx += eax << 8
                out.push(0x89, 0xd9);                                      // mov ecx, ebx
                out.push(0xff, 0x15, ...rip(iat('ExitProcess'), 6), 0xf4);
                return out;
            },
        });
        const cork = await run(exe);
        // 18 bytes and memcmp 0, then _snprintf's -1 shifted in.
        assert.equal(cork.code >>> 0, (18 + (-1 << 8)) >>> 0);
        const hosted = cork.trapsHot.map(([name])=>name).filter(name=>/printf/.test(name));
        assert.deepEqual(hosted, [], 'neither crossed to the host');
    });

/**
 * The data of a program that formats "%d-%s" of 12345 and "ab" (8 bytes) through
 * the UCRT's printers into buffers of 12 bytes, and what each holds after.
 */
const COMMON_PRINT_DATA = (()=>{
    const text = (/** @type {string} */ value)=>[...value].map(c=>c.charCodeAt(0));
    return { format: [...text('%d-%s'), 0], word: [...text('ab'), 0],
        b1: new Array(12).fill(0x55), b2: new Array(12).fill(0x55),
        b3: new Array(12).fill(0x55), b4: new Array(12).fill(0x55),
        // C99's snprintf into 5: what fits and a terminator; _vsnprintf's: 5 bytes and the
        // next untouched; under LEGACY_VSPRINTF_NULL_TERMINATION the fifth made the terminator.
        w1: [...text('1234'), 0], w2: [...text('12345'), 0x55], w3: [...text('1234'), 0],
        w4: [...text('12345-ab'), 0] };
})();

/** The calls of that program: options, buffer (null for none), count, and the function. */
const COMMON_PRINT_CALLS = /** @type {const} */ ([[2, 'b1', 5, 0], [0, 'b2', 5, 0],
    [1, 'b3', 5, 0], [2, null, 0, 0], [0, 'b4', 9, 1]]);

/**
 * Where each call's answer goes in the exit code: 8 the first, -1 + 1 the two
 * legacy ones shifted, 8 << 8 the length asked for, 8 << 16 vsprintf_s's; each
 * memcmp of a buffer and what it should hold added << 24.
 */
const COMMON_PRINT_CODE = 8 + (8 << 8) + (8 << 16);

const COMMON_PRINT_COMPARED = /** @type {const} */ ([['b1', 'w1', 5], ['b2', 'w2', 6],
    ['b3', 'w3', 5], ['b4', 'w4', 9]]);

/** @type {Record<number, number[]>} after the answer of call i is in EAX */
const COMMON_PRINT_FOLD = {
    0: [0x89, 0xc3],                                                  // mov ebx, eax
    1: [0x83, 0xc0, 0x01, 0xc1, 0xe0, 0x04, 0x01, 0xc3],             // ebx += (eax + 1) << 4
    2: [0x83, 0xc0, 0x01, 0xc1, 0xe0, 0x05, 0x01, 0xc3],             // ebx += (eax + 1) << 5
    3: [0xc1, 0xe0, 0x08, 0x01, 0xc3],                                // ebx += eax << 8
    4: [0xc1, 0xe0, 0x10, 0x01, 0xc3],                                // ebx += eax << 16
};

test('a 32-bit program\'s UCRT printers run as guest code under each behaviour their options'
    + ' pick, the options two slots', async()=>{
    const exe = buildExe({
        imports: { 'api-ms-win-crt-stdio-l1-1-0.dll': ['__stdio_common_vsprintf',
            '__stdio_common_vsprintf_s'], 'api-ms-win-crt-string-l1-1-0.dll': ['memcmp'],
        'KERNEL32.dll': ['ExitProcess'] },
        data: COMMON_PRINT_DATA,
        codeSize: 0x180,
        code: ({ iat, at })=>{
            /** @type {number[]} */
            const out = [0x68, ...u32(at('word')), 0x68, ...u32(12345), 0x89, 0xe6];
            COMMON_PRINT_CALLS.forEach(([options, buffer, count, secure], i)=>{
                out.push(0x56, 0x6a, 0x00, 0x68, ...u32(at('format')), 0x6a, count);
                out.push(...buffer === null ? [0x6a, 0x00] : [0x68, ...u32(at(buffer))]);
                out.push(0x6a, 0x00, 0x6a, options);                    // the options' two halves
                out.push(0xff, 0x15, ...u32(iat(secure ? '__stdio_common_vsprintf_s'
                    : '__stdio_common_vsprintf')));
                out.push(0x83, 0xc4, 0x1c, ...COMMON_PRINT_FOLD[i]);
            });
            for (const [buffer, want, length] of COMMON_PRINT_COMPARED)
            {
                out.push(0x6a, length, 0x68, ...u32(at(want)), 0x68, ...u32(at(buffer)));
                out.push(0xff, 0x15, ...u32(iat('memcmp')), 0x83, 0xc4, 0x0c);
                out.push(0xc1, 0xe0, 0x18, 0x01, 0xc3);                // ebx += eax << 24
            }
            out.push(0x53, 0xff, 0x15, ...u32(iat('ExitProcess')), 0xf4);
            return out;
        },
    });
    const cork = await run(exe);
    assert.equal(cork.code >>> 0, COMMON_PRINT_CODE);
    const hosted = cork.trapsHot.map(([name])=>name).filter(name=>/printf/.test(name));
    assert.deepEqual(hosted, [], 'none crossed to the host');
});

test('a 64-bit program\'s UCRT printers run as guest code under each behaviour their options'
    + ' pick, the options one register', async()=>{
    const exe = buildExe({
        bits: 64,
        imports: { 'api-ms-win-crt-stdio-l1-1-0.dll': ['__stdio_common_vsprintf',
            '__stdio_common_vsprintf_s'], 'api-ms-win-crt-string-l1-1-0.dll': ['memcmp'],
        'KERNEL32.dll': ['ExitProcess'] },
        data: COMMON_PRINT_DATA,
        codeSize: 0x240,
        code: ({ iat, at, code })=>{
            /** @type {number[]} */
            const out = [];
            const rip = (/** @type {number} */ target, /** @type {number} */ rest)=>
                u32((target - code(out.length + rest)) >>> 0);
            out.push(0x53, 0x48, 0x83, 0xec, 0x50);                    // push rbx; sub rsp, 80
            // The va_list: 12345 and "ab" in slots of eight bytes at [rsp+64].
            out.push(0x48, 0xc7, 0x44, 0x24, 0x40, ...u32(12345));
            out.push(0x48, 0x8d, 0x05, ...rip(at('word'), 7));        // lea rax, word
            out.push(0x48, 0x89, 0x44, 0x24, 0x48);                    // mov [rsp+72], rax
            COMMON_PRINT_CALLS.forEach(([options, buffer, count, secure], i)=>{
                // The locale ([rsp+32]) a value of its own, the va_list at [rsp+40].
                out.push(0x48, 0xc7, 0x44, 0x24, 0x20, ...u32(0x5eed));
                out.push(0x48, 0x8d, 0x44, 0x24, 0x40);                // lea rax, [rsp+64]
                out.push(0x48, 0x89, 0x44, 0x24, 0x28);                // mov [rsp+40], rax
                out.push(0x48, 0xb9, options, 0, 0, 0, 0x34, 0x12, 0, 0); // mov rcx, options
                out.push(...buffer === null ? [0x31, 0xd2]
                    : [0x48, 0x8d, 0x15, ...rip(at(buffer), 7)]);   // rdx: the buffer
                out.push(0x41, 0xb8, ...u32(count));                   // mov r8d, count
                out.push(0x4c, 0x8d, 0x0d, ...rip(at('format'), 7));   // lea r9, format
                out.push(0xff, 0x15, ...rip(iat(secure ? '__stdio_common_vsprintf_s'
                    : '__stdio_common_vsprintf'), 6));
                out.push(...COMMON_PRINT_FOLD[i]);
            });
            for (const [buffer, want, length] of COMMON_PRINT_COMPARED)
            {
                out.push(0x48, 0x8d, 0x0d, ...rip(at(buffer), 7));
                out.push(0x48, 0x8d, 0x15, ...rip(at(want), 7));
                out.push(0x41, 0xb8, ...u32(length));
                out.push(0xff, 0x15, ...rip(iat('memcmp'), 6));
                out.push(0xc1, 0xe0, 0x18, 0x01, 0xc3);
            }
            out.push(0x89, 0xd9);                                      // mov ecx, ebx
            out.push(0xff, 0x15, ...rip(iat('ExitProcess'), 6), 0xf4);
            return out;
        },
    });
    const cork = await run(exe);
    assert.equal(cork.code >>> 0, COMMON_PRINT_CODE);
    const hosted = cork.trapsHot.map(([name])=>name).filter(name=>/printf/.test(name));
    assert.deepEqual(hosted, [], 'none crossed to the host');
});

test('a 64-bit program\'s sprintf of a double is the host\'s, its va_list the spilled home space',
    async()=>{
        // sprintf(buffer, "%d|%.1f|%s", 7, 2.5, "ok"): the double in R9 and XMM3 both, as a
        // variadic call passes it; the exit code its length, 256 times memcmp's answer added.
        const text = (/** @type {string} */ value)=>[...value].map(c=>c.charCodeAt(0));
        const exe = buildExe({
            bits: 64,
            imports: { 'msvcrt.dll': ['sprintf', 'memcmp'], 'KERNEL32.dll': ['ExitProcess'] },
            data: { format: [...text('%d|%.1f|%s'), 0], word: [...text('ok'), 0],
                want: [...text('7|2.5|ok'), 0], buffer: new Array(32).fill(0x55) },
            codeSize: 0xa0,
            code: ({ iat, at, code })=>{
                /** @type {number[]} */
                const out = [];
                const rip = (/** @type {number} */ target, /** @type {number} */ rest)=>
                    u32((target - code(out.length + rest)) >>> 0);
                out.push(0x53, 0x48, 0x83, 0xec, 0x30);                    // push rbx; sub rsp, 48
                out.push(0x48, 0x8d, 0x0d, ...rip(at('buffer'), 7));
                out.push(0x48, 0x8d, 0x15, ...rip(at('format'), 7));
                out.push(0x41, 0xb8, ...u32(7));                           // mov r8d, 7
                out.push(0x49, 0xb9, 0, 0, 0, 0, 0, 0, 0x04, 0x40);        // mov r9, 2.5's bits
                out.push(0x66, 0x49, 0x0f, 0x6e, 0xd9);                    // movq xmm3, r9
                out.push(0x48, 0x8d, 0x05, ...rip(at('word'), 7));         // lea rax, word
                out.push(0x48, 0x89, 0x44, 0x24, 0x20);                    // mov [rsp+32], rax
                out.push(0xff, 0x15, ...rip(iat('sprintf'), 6));
                out.push(0x89, 0xc3);                                      // mov ebx, eax
                out.push(0x48, 0x8d, 0x0d, ...rip(at('buffer'), 7));
                out.push(0x48, 0x8d, 0x15, ...rip(at('want'), 7));
                out.push(0x41, 0xb8, ...u32(9));
                out.push(0xff, 0x15, ...rip(iat('memcmp'), 6));
                out.push(0xc1, 0xe0, 0x08, 0x01, 0xc3);                    // ebx += eax << 8
                out.push(0x89, 0xd9);
                out.push(0xff, 0x15, ...rip(iat('ExitProcess'), 6), 0xf4);
                return out;
            },
        });
        const cork = await run(exe);
        assert.equal(cork.code, 8, 'eight bytes, as the host printed them');
    });

test('a 64-bit program\'s msvcrt strtod and atof run as guest code, *end a whole pointer',
    async()=>{
        // strtod("1.25e2xy", &end) + atof("-0.5"): 124.5, its double's low dword the exit
        // code's low half; end - text (6) in its high half, and the quadword end's upper half
        // (preset to all ones) added in.
        const text = (/** @type {string} */ value)=>[...value].map(c=>c.charCodeAt(0));
        const exe = buildExe({
            bits: 64,
            imports: { 'msvcrt.dll': ['strtod', 'atof'], 'KERNEL32.dll': ['ExitProcess'] },
            data: { number: [...text('1.25e2xy'), 0], half: [...text('-0.5'), 0],
                end: new Array(8).fill(0xff), sum: new Array(8).fill(0) },
            codeSize: 0xa0,
            code: ({ iat, at, code })=>{
                /** @type {number[]} */
                const out = [];
                const rip = (/** @type {number} */ target, /** @type {number} */ rest)=>
                    u32((target - code(out.length + rest)) >>> 0);
                out.push(0x48, 0x83, 0xec, 0x28);
                out.push(0x48, 0x8d, 0x0d, ...rip(at('number'), 7));       // lea rcx, number
                out.push(0x48, 0x8d, 0x15, ...rip(at('end'), 7));          // lea rdx, end
                out.push(0xff, 0x15, ...rip(iat('strtod'), 6));
                out.push(0xf2, 0x0f, 0x11, 0x05, ...rip(at('sum'), 8));    // movsd [sum], xmm0
                out.push(0x48, 0x8d, 0x0d, ...rip(at('half'), 7));
                out.push(0xff, 0x15, ...rip(iat('atof'), 6));
                out.push(0xf2, 0x0f, 0x58, 0x05, ...rip(at('sum'), 8));    // addsd xmm0, [sum]
                out.push(0xf2, 0x0f, 0x2c, 0xc8);                          // cvttsd2si ecx, xmm0
                out.push(0x48, 0x8b, 0x05, ...rip(at('end'), 7));          // mov rax, [end]
                out.push(0x48, 0x8d, 0x15, ...rip(at('number'), 7));       // lea rdx, number
                out.push(0x48, 0x29, 0xd0);                                // sub rax, rdx
                out.push(0x48, 0xc1, 0xe0, 0x10);                          // shl rax, 16
                out.push(0x01, 0xc1);                                      // add ecx, eax
                out.push(0x48, 0xc1, 0xe8, 0x20);                          // shr rax, 32
                out.push(0x01, 0xc1);                                      // add ecx, eax
                out.push(0xff, 0x15, ...rip(iat('ExitProcess'), 6), 0xf4);
                return out;
            },
        });
        const cork = await run(exe);
        assert.equal(cork.code, 124 + (6 << 16), 'the sum, the end six bytes in, its upper half 0');
        const hosted = cork.trapsHot.map(([name])=>name).filter(name=>/strtod|atof/.test(name));
        assert.deepEqual(hosted, [], 'neither crossed to the host');
    });

test('a 64-bit program\'s msvcrt _isnan, _finite and _copysign read XMM bits in the guest',
    async()=>{
        // _isnan(NaN) + 2 * _finite(Infinity) + 4 * _finite(1.5) + 8 * (copysign(3, -0) < 0):
        // 1 + 0 + 4 + 8.
        const f64 = (/** @type {number} */ x)=>[...new Uint8Array(new Float64Array([x]).buffer)];
        const exe = buildExe({
            bits: 64,
            imports: { 'msvcrt.dll': ['_isnan', '_finite', '_copysign'],
                'KERNEL32.dll': ['ExitProcess'] },
            data: { nan: f64(NaN), inf: f64(Infinity), one: f64(1.5), three: f64(3),
                zero: f64(-0) },
            codeSize: 0xc0,
            code: ({ iat, at, code })=>{
                /** @type {number[]} */
                const out = [];
                const rip = (/** @type {number} */ target, /** @type {number} */ rest)=>
                    u32((target - code(out.length + rest)) >>> 0);
                const load = (/** @type {string} */ name, /** @type {number} */ reg)=>
                    out.push(0xf2, 0x0f, 0x10, 0x05 | reg << 3, ...rip(at(name), 8));
                out.push(0x53, 0x48, 0x83, 0xec, 0x20);                    // push rbx; sub rsp, 32
                load('nan', 0);
                out.push(0xff, 0x15, ...rip(iat('_isnan'), 6));
                out.push(0x89, 0xc3);                                      // mov ebx, eax
                load('inf', 0);
                out.push(0xff, 0x15, ...rip(iat('_finite'), 6));
                out.push(0x8d, 0x1c, 0x43);                                // lea ebx, [rbx+rax*2]
                load('one', 0);
                out.push(0xff, 0x15, ...rip(iat('_finite'), 6));
                out.push(0x8d, 0x1c, 0x83);                                // lea ebx, [rbx+rax*4]
                load('three', 0);
                load('zero', 1);
                out.push(0xff, 0x15, ...rip(iat('_copysign'), 6));
                out.push(0x66, 0x48, 0x0f, 0x7e, 0xc0);                    // movq rax, xmm0
                out.push(0x48, 0xc1, 0xe8, 0x3f);                          // shr rax, 63
                out.push(0x8d, 0x0c, 0xc3);                                // lea ecx, [rbx+rax*8]
                out.push(0xff, 0x15, ...rip(iat('ExitProcess'), 6), 0xf4);
                return out;
            },
        });
        const cork = await run(exe);
        assert.equal(cork.code, 13);
        const hosted = cork.trapsHot.map(([name])=>name)
            .filter(name=>/_isnan|_finite|_copysign/.test(name));
        assert.deepEqual(hosted, [], 'none crossed to the host');
    });

test('a 64-bit program\'s msvcrt srand, rand, div and ldiv run as guest code, div_t whole in RAX',
    async()=>{
        // srand(42); a = rand(); b = rand(); div(-7, 2) = { -3, -1 }; ldiv(9, -4) = { -2, 1 }.
        // The exit code: (a ^ b << 3) & 0xffff, then div's quotient and remainder plus 8
        // in bits 16-19 and 20-23, ldiv's in 24-27 and 28-31.
        const exe = buildExe({
            bits: 64,
            imports: { 'msvcrt.dll': ['srand', 'rand', 'div', 'ldiv'],
                'KERNEL32.dll': ['ExitProcess'] },
            data: {},
            codeSize: 0xc0,
            code: ({ iat, code })=>{
                /** @type {number[]} */
                const out = [];
                const rip = (/** @type {number} */ target, /** @type {number} */ rest)=>
                    u32((target - code(out.length + rest)) >>> 0);
                // The div_t in RAX into its two halves plus 8, each in a nibble at `shift`.
                const nibbles = (/** @type {number} */ shift)=>{
                    out.push(0x48, 0x89, 0xc2);                            // mov rdx, rax
                    out.push(0x83, 0xc0, 0x08, 0x83, 0xe0, 0x0f);          // eax = (eax + 8) & 15
                    out.push(0xc1, 0xe0, shift, 0x09, 0xc3);               // ebx |= eax << shift
                    out.push(0x48, 0xc1, 0xea, 0x20);                      // shr rdx, 32
                    out.push(0x83, 0xc2, 0x08, 0x83, 0xe2, 0x0f);          // edx = (edx + 8) & 15
                    out.push(0xc1, 0xe2, shift + 4, 0x09, 0xd3);           // ebx |= edx << shift+4
                };
                out.push(0x53, 0x56, 0x48, 0x83, 0xec, 0x28);              // push rbx, rsi; sub rsp
                out.push(0xb9, ...u32(42));                                // mov ecx, 42
                out.push(0xff, 0x15, ...rip(iat('srand'), 6));
                out.push(0xff, 0x15, ...rip(iat('rand'), 6));
                out.push(0x89, 0xc6);                                      // mov esi, eax
                out.push(0xff, 0x15, ...rip(iat('rand'), 6));
                out.push(0xc1, 0xe0, 0x03, 0x31, 0xf0);                    // eax = b << 3 ^ a
                out.push(0x0f, 0xb7, 0xd8);                                // movzx ebx, ax
                out.push(0xb9, ...u32(-7 >>> 0), 0xba, ...u32(2));         // ecx -7, edx 2
                out.push(0xff, 0x15, ...rip(iat('div'), 6));
                nibbles(16);
                out.push(0xb9, ...u32(9), 0xba, ...u32(-4 >>> 0));         // ecx 9, edx -4
                out.push(0xff, 0x15, ...rip(iat('ldiv'), 6));
                nibbles(24);
                out.push(0x89, 0xd9);                                      // mov ecx, ebx
                out.push(0xff, 0x15, ...rip(iat('ExitProcess'), 6), 0xf4);
                return out;
            },
        });
        const cork = await run(exe);
        let seed = 42;
        const draw = ()=>{
            seed = (Math.imul(seed, 214013) + 2531011) >>> 0;
            return (seed >>> 16) & 0x7fff;
        };
        const a = draw();
        const b = draw();
        const want = ((a ^ b << 3) & 0xffff | (-3 + 8) << 16 | (-1 + 8) << 20 | (-2 + 8) << 24
            | (1 + 8) << 28) >>> 0;
        assert.equal(cork.code >>> 0, want);
        const hosted = cork.trapsHot.map(([name])=>name).filter(name=>/rand|div/.test(name));
        assert.deepEqual(hosted, [], 'none crossed to the host');
    });
