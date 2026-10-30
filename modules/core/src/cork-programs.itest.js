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
        assert.equal(cork.diagnostics.metrics?.engine, 'cork');
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
    const app = await createApp({ executable: exe, engine: 'cork' });
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
            engine: 'cork',
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
