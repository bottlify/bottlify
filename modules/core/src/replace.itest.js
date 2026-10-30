/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A child is visible to whoever is reading the log.
 *
 * A launcher starts its game and exits: the game runs beside it on a machine
 * of its own, and goes on when the launcher has gone. Everything the reader
 * holds -- the level it raised at run time, the cursor it drains from, the sink
 * it attached -- has to reach that machine, or the call log simply stops at the
 * launcher and the game runs unobserved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import {
    slotHeaderOffset, slotPcmOffset, SLOT_HEADER_INT32, SLOT_BYTES, PCM_MASK,
    STATE, STATE_OPEN, RATE, CHANNELS, BITS, GAIN, GAIN_SCALE, WRITTEN, READ,
} from './layers/audio/output/mix.js';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * Calls GetSystemMetrics once, then writes two bytes to stdout and exits.
 *
 * The second write is what tells a sink that detached after the first one
 * whether the detach held.
 */
function buildChildExe(){
    return buildExe({
        imports: {
            'USER32.dll': ['GetSystemMetrics'],
            'KERNEL32.dll': ['GetStdHandle', 'WriteFile', 'ExitProcess'],
        },
        codeSize: 0x100,
        data: {
            first: [0x41],
            second: [0x42],
            written: [0, 0, 0, 0],
        },
        code: ({ iat, at })=>[
            0x6a, 0x00, //                                        push SM_CXSCREEN
            0xff, 0x15, ...u32(iat('GetSystemMetrics')),

            0x6a, 0xf5, //                                        push STD_OUTPUT_HANDLE
            0xff, 0x15, ...u32(iat('GetStdHandle')),
            0x6a, 0x00,
            0x68, ...u32(at('written')),
            0x6a, 0x01,
            0x68, ...u32(at('first')),
            0x50,
            0xff, 0x15, ...u32(iat('WriteFile')),

            0x6a, 0xf5,
            0xff, 0x15, ...u32(iat('GetStdHandle')),
            0x6a, 0x00,
            0x68, ...u32(at('written')),
            0x6a, 0x01,
            0x68, ...u32(at('second')),
            0x50,
            0xff, 0x15, ...u32(iat('WriteFile')),

            0x6a, 0x00,
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
}

/** Starts C:\App\Child.exe and exits, so the child takes its place. */
function buildParentExe(){
    // A parent that has done some work of its own before handing over: a run
    // that made no calls leaves the reader's cursor below the child's own
    // sequence numbers, where a fresh journal looks continuous by accident.
    const CALLS = 100;
    const body = [
        0x6a, 0x00, //                             push SM_CXSCREEN
        0xff, 0x15, ...u32(0), //                  call [GetSystemMetrics], patched below
        0xff, 0x0d, ...u32(0), //                  dec [calls], patched below
        0x75, 0x00, //                             jnz loop, patched below
    ];

    return buildExe({
        imports: {
            'USER32.dll': ['GetSystemMetrics'],
            'KERNEL32.dll': ['CreateProcessA', 'ExitProcess'],
        },
        codeSize: 0x200,
        data: {
            calls: u32(CALLS),
            child: [...'C:\\App\\Child.exe'].map(c=>c.charCodeAt(0)).concat(0),
            // STARTUPINFOA with cb = 68, and the PROCESS_INFORMATION it fills.
            startup: [68, ...new Array(67).fill(0)],
            information: new Array(16).fill(0),
        },
        code: ({ iat, at })=>{
            const loop = [...body];
            loop.splice(4, 4, ...u32(iat('GetSystemMetrics')));
            loop.splice(10, 4, ...u32(at('calls')));
            loop[15] = (-loop.length) & 0xff;

            return [
                ...loop,
                0x68, ...u32(at('information')), //  push &pi        (lpProcessInformation)
                0x68, ...u32(at('startup')), //      push &si        (lpStartupInfo)
                0x6a, 0x00, //                       lpCurrentDirectory
                0x6a, 0x00, //                       lpEnvironment
                0x6a, 0x00, //                       dwCreationFlags
                0x6a, 0x00, //                       bInheritHandles
                0x6a, 0x00, //                       lpThreadAttributes
                0x6a, 0x00, //                       lpProcessAttributes
                0x6a, 0x00, //                       lpCommandLine
                0x68, ...u32(at('child')), //        lpApplicationName
                0xff, 0x15, ...u32(iat('CreateProcessA')),

                0x6a, 0x00,
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
        },
    });
}

test('the reader keeps its level, its cursor and its sink across a child it starts',
    { timeout: 60_000 }, async t=>{
        // The decoder binary is fetched, not tracked; without it this test still
        // exercises the child, and the instance sharing below is skipped.
        const decoder = await readFile(new URL('video-decoder.wasm', PREBUILT)).catch(()=>null);
        const child = buildChildExe();
        // The GPU the worker would have opened, and the canvas it presents into.
        // The run's presenter belongs to the run, not to either process: the
        // child has to draw into the canvas the parent's frame is already on.
        const gpu = createFakeDevice();

        const app = await createApp({
            executable: buildParentExe(),
            imagePath: 'C:\\App\\Parent.exe',
            device: {
                device: gpu.device,
                queue: gpu.queue,
                screen: gpu.screen,
                canvas: gpu.canvas,
                adapter: { vendor: 'fake', architecture: '', description: 'a stand-in' },
            },
            // A call area on from the first instruction is what a `?log=` asks for.
            log: { categories: { 'call.cpu': 'trace' } },
            // Something is reading the far end of the sound ring, as the launcher
            // does when its worklet is attached. It matters here because the ring
            // is the machine's, not the program's: the child has to mix into the
            // output the reader was handed before the parent ran.
            audio: { drained: true },
            media: decoder ? {
                wasmBytes: decoder.buffer.slice(
                    decoder.byteOffset, decoder.byteOffset + decoder.byteLength),
            } : undefined,
            // The child the parent hands over to has to be on the volume.
            storage: { load: async()=>({ files: [{ path: 'C:\\App\\Child.exe', bytes: child }] }) },
        });
        t.after(()=>app.dispose());

        // The decoder is instantiated off the thread while the machine comes up.
        // Waited for here so the parent's instance is unambiguously the one the
        // child has to attach to.
        for (let guard = 0; guard < 500 && app.media.instance() === null; guard++)
        {
            await new Promise(resolve=>setImmediate(resolve));
        }
        const parentDecoder = app.media.instance();
        if (decoder)
        {
            assert.ok(parentDecoder, 'the parent instantiated the configured decoder');
        }

        // Switched on and raised after the machine exists, the way the launcher's
        // session does. Neither survives a rebuild today.
        app.log.setLevel('call.input', 'trace');
        app.log.setDefaultLevel('debug');

        // A reader holds a cursor taken from the parent. Nothing is written before
        // its first call, so take it again at the handover -- the parent's last
        // lines then -- which is the cursor a live view would be holding.
        let cursor = app.log.drain(0, 1000).next;
        /** What the parent's journal had reached when it started its child. */
        let replacedAt = 0;
        app.on('process-child', ()=>{
            cursor = app.log.drain(0, 1000).next;
            replacedAt = cursor;
        });

        // The child's journal is a fresh block whose numbering continues the
        // parent's. `process-started` carries the base it begins at, which is the
        // one thing a keeper following the swap cannot work out for itself.
        /** @type {{ image: string, sequenceBase: number } | null} */
        let started = null;
        app.on('process-started', (/** @type {any} */ payload)=>{
            started = payload;
        });

        /** @type {string[]} */
        const output = [];
        /** @param {number} _handle @param {string} text */
        const sink = (_handle, text)=>{
            output.push(text);
            app.detachLog(sink);
        };
        app.attachLog(sink);

        // The sound output the parent's machine made, and what a reader on the
        // page was handed for its worklet: a shared track table, this run has
        // one because Node has `SharedArrayBuffer`. A little of the parent's
        // sound is put in and taken out -- standing in for the audio thread,
        // the way `worklet.js`'s `resampleInto` would -- so the cursor the
        // reader holds is not at zero.
        const table = app.audio.table();
        const header = new Int32Array(table, slotHeaderOffset(0), SLOT_HEADER_INT32);
        const pcm = new Uint8Array(table, slotPcmOffset(0), SLOT_BYTES);
        Atomics.store(header, STATE, STATE_OPEN);
        Atomics.store(header, RATE, 48000);
        Atomics.store(header, CHANNELS, 2);
        Atomics.store(header, BITS, 16);
        Atomics.store(header, GAIN, GAIN_SCALE);
        pcm.set([0, 4, 0, 4, 0, 8, 0, 8], 0); // two stereo 16-bit frames; the values do not matter
        Atomics.store(header, WRITTEN, 8);
        Atomics.store(header, READ, 8); // the reader took both frames
        const consumed = Atomics.load(header, READ);
        assert.ok(consumed > 0, 'the reader is not at the start of the table');

        // The presenter is a service of the run: made once, above both machines,
        // and the same object after the swap. The parent's frame is presented
        // before it is replaced, the child's after; the canvas is configured for
        // the first of them and never again, which is what leaves the parent's last
        // frame on it until the child presents its own.
        const presenter = app.presenter();
        assert.ok(presenter, 'createApp made one presenter for the run');
        const surface = { buffer: 0x400000, width: 1, height: 1, pitch: 4, bitCount: 32,
            palette: null };
        presenter.present(surface);
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(gpu.count('configure'), 1, 'the parent\'s frame configured the canvas');
        assert.equal(presenter.diagnostics().presents, 1);

        const code = await app.run({ timeoutMs: 60_000 });
        assert.equal(code, 0, 'the child exited cleanly');

        // The same presenter, now attached to the child's machine: the count
        // continues rather than restarting, and the canvas was not configured again
        // at the swap -- a reconfigure clears it, which is the black frame.
        presenter.present(surface);
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(app.presenter(), presenter, 'the run kept the presenter it made');
        assert.equal(presenter.diagnostics().presents, 2,
            'the count continued into the child');
        assert.equal(gpu.count('configure'), 1, 'the canvas was not reconfigured at the swap');

        // The child's own GetSystemMetrics reached the journal at the level the
        // page raised. Its category was never set in the `log` option.
        const after = app.log.drain(cursor, 1000);
        const call = after.records.find((/** @type {any} */ record)=>
            record.category === 'call.input' && record.text.includes('GetSystemMetrics'));
        assert.ok(call, `the child's call was logged after the handover: ${
            after.records.map((/** @type {any} */ record)=>record.text).join(' | ')}`);

        // And it arrived through the cursor taken before the parent ran: the new
        // journal's sequence numbers continue the old one's rather than restart.
        assert.ok(after.records.length > 0,
            'draining from the parent\'s cursor returned the child\'s lines');

        // `process-started` named the block the child's journal begins at, and the
        // child's own records start exactly there -- the signal a keeper following
        // the swap uses to pick up the next block.
        assert.ok(started, 'process-started fired after the rebuild');
        const announced = /** @type {{ image: string, sequenceBase: number }} */ (started);
        assert.equal(announced.image, 'C:\\App\\Child.exe');
        assert.ok(announced.sequenceBase >= replacedAt,
            'the child continues the sequence the parent reached');
        assert.ok(after.records.some((/** @type {any} */ record)=>
            record.sequence === announced.sequenceBase),
        'and the child\'s journal actually starts at that base');

        // The sink attached before the handover was still the one detachLog knew.
        assert.deepEqual(output, ['A'],
            'detaching while the child ran stopped the sink receiving');

        // The child's machine writes into the table the reader already holds,
        // rather than making one of its own that nobody would read.
        const childTable = app.audio.table();
        assert.equal(childTable, table, 'the same table');
        const childHeader = new Int32Array(childTable, slotHeaderOffset(0), SLOT_HEADER_INT32);
        assert.equal(Atomics.load(childHeader, READ), consumed,
            'the read cursor continued, not reset');

        const childPcm = new Uint8Array(childTable, slotPcmOffset(0), SLOT_BYTES);
        const writtenBefore = Atomics.load(childHeader, WRITTEN);
        childPcm.set([0, 12, 0, 12], writtenBefore & PCM_MASK);
        Atomics.store(childHeader, WRITTEN, writtenBefore + 4);
        Atomics.store(childHeader, READ, consumed + 4);
        assert.equal(Atomics.load(childHeader, READ), consumed + 4,
            'and the reader keeps counting');

        // The decoder is a service of the run, not of the process: the child
        // attaches to the instance the parent made instead of compiling the binary
        // again and paying for it on its first cinematic.
        if (decoder)
        {
            assert.ok(parentDecoder, 'the parent had made a decoder to hand over');
            assert.equal(app.media.instance(), parentDecoder,
                'the child uses the parent\'s decoder, not a new one');
        }
    });

/** The name a single-instance mutex is probed and created under, in both processes. */
const MUTEX_NAME = 'BottlifyReplacementInstanceMutex';

/**
 * Creates a named mutex and hands over to `C:\App\Child.exe`, without ever
 * closing the mutex handle -- exactly what a process that is about to be
 * replaced does, since nothing here models an orderly shutdown.
 */
function buildMutexParentExe(){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['CreateMutexA', 'CreateProcessA', 'ExitProcess'],
        },
        codeSize: 0x100,
        data: {
            name: [...MUTEX_NAME].map(c=>c.charCodeAt(0)).concat(0),
            child: [...'C:\\App\\Child.exe'].map(c=>c.charCodeAt(0)).concat(0),
            startup: [68, ...new Array(67).fill(0)],
            information: new Array(16).fill(0),
        },
        code: ({ iat, at })=>[
            0x68, ...u32(at('name')),
            0x6a, 0x00,
            0x6a, 0x00,
            0xff, 0x15, ...u32(iat('CreateMutexA')),

            0x68, ...u32(at('information')), //  lpProcessInformation
            0x68, ...u32(at('startup')), //      lpStartupInfo
            0x6a, 0x00, //                       lpCurrentDirectory
            0x6a, 0x00, //                       lpEnvironment
            0x6a, 0x00, //                       dwCreationFlags
            0x6a, 0x00, //                       bInheritHandles
            0x6a, 0x00, //                       lpThreadAttributes
            0x6a, 0x00, //                       lpProcessAttributes
            0x6a, 0x00, //                       lpCommandLine
            0x68, ...u32(at('child')), //        lpApplicationName
            0xff, 0x15, ...u32(iat('CreateProcessA')),

            0x6a, 0x00,
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
}

/**
 * Probes the same name the parent created and reports what it found: the low
 * byte of GetLastError() after CreateMutexA, written to stdout.
 */
function buildMutexChildExe(){
    return buildExe({
        imports: {
            'KERNEL32.dll': [
                'CreateMutexA', 'GetLastError', 'GetStdHandle', 'WriteFile', 'ExitProcess',
            ],
        },
        codeSize: 0x100,
        data: {
            name: [...MUTEX_NAME].map(c=>c.charCodeAt(0)).concat(0),
            errorByte: [0],
            written: [0, 0, 0, 0],
        },
        code: ({ iat, at })=>[
            0x68, ...u32(at('name')),
            0x6a, 0x00,
            0x6a, 0x00,
            0xff, 0x15, ...u32(iat('CreateMutexA')),

            0xff, 0x15, ...u32(iat('GetLastError')), //  no arguments, result in EAX
            0xa2, ...u32(at('errorByte')), //             mov [errorByte], al

            0x6a, 0xf5, //                        push STD_OUTPUT_HANDLE
            0xff, 0x15, ...u32(iat('GetStdHandle')),
            0x6a, 0x00,
            0x68, ...u32(at('written')),
            0x6a, 0x01,
            0x68, ...u32(at('errorByte')),
            0x50,
            0xff, 0x15, ...u32(iat('WriteFile')),

            0x6a, 0x00,
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
}

test('a mutex the parent named is ERROR_ALREADY_EXISTS when the child names it too', async t=>{
    const child = buildMutexChildExe();

    const app = await createApp({
        executable: buildMutexParentExe(),
        imagePath: 'C:\\App\\Parent.exe',
        storage: { load: async()=>({ files: [{ path: 'C:\\App\\Child.exe', bytes: child }] }) },
    });
    t.after(()=>app.dispose());

    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));

    const code = await app.run({ timeoutMs: 60_000 });

    assert.equal(code, 0, 'the child exited cleanly');
    const ERROR_ALREADY_EXISTS = 183;
    assert.equal(output.join('').charCodeAt(0), ERROR_ALREADY_EXISTS,
        'the child found the name the parent registered, never closed across the handover');
});

for (const concurrency of /** @type {(1 | 2)[]} */ ([1, 2]))
{
    test(`a process's windows go when it exits, and the one started in its place finds none of`
        + ` them (concurrency ${concurrency})`, { timeout: 60000 }, async t=>{
        // InstallShield's setup shows a window, starts a copy of itself and
        // exits; the copy shows its wizard. On Windows the first process's
        // windows are destroyed with it. Carried into the copy, its window
        // stayed on the screen under the wizard for the whole install, its
        // destruction refused as another thread's.
        const ascii = (/** @type {string} */ text)=>[...text].map(c=>c.charCodeAt(0)).concat(0);
        const parent = buildExe({
            imports: { 'USER32.dll': ['CreateWindowExA'],
                'KERNEL32.dll': ['CreateProcessA', 'ExitProcess'] },
            codeSize: 0x100,
            data: {
                kind: ascii('STATIC'),
                title: ascii('left by the parent'),
                child: ascii('C:\\App\\Child.exe'),
                startup: [68, ...new Array(67).fill(0)],
                information: new Array(16).fill(0),
            },
            code: ({ iat, at })=>[
                // CreateWindowExA(0, "STATIC", title, WS_POPUP | WS_VISIBLE, 0, 0, 100, 50, ...)
                0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
                0x6a, 50, 0x6a, 100, 0x6a, 0, 0x6a, 0,
                0x68, ...u32(0x90000000),
                0x68, ...u32(at('title')), 0x68, ...u32(at('kind')), 0x6a, 0,
                0xff, 0x15, ...u32(iat('CreateWindowExA')),
                0x68, ...u32(at('information')), 0x68, ...u32(at('startup')),
                0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
                0x68, ...u32(at('child')),
                0xff, 0x15, ...u32(iat('CreateProcessA')),
                0x6a, 0, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
        });
        // Exits with FindWindowA(NULL, title): zero when the parent's window is gone.
        const child = buildExe({
            imports: { 'USER32.dll': ['FindWindowA'], 'KERNEL32.dll': ['ExitProcess'] },
            codeSize: 0x40,
            data: { title: ascii('left by the parent') },
            code: ({ iat, at })=>[
                0x68, ...u32(at('title')), 0x6a, 0,
                0xff, 0x15, ...u32(iat('FindWindowA')),
                0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
        });
        const app = await createApp({
            executable: parent,
            imagePath: 'C:\\App\\Parent.exe',
            engine: 'cork',
            concurrency,
            storage: { load: async()=>({ files: [{ path: 'C:\\App\\Child.exe', bytes: child }] }) },
        });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 60_000 }), 0,
            'the child found no window of the parent');
        assert.deepEqual((await app.debug.windows()).filter((/** @type {any} */ each)=>
            each.title === 'left by the parent'), [], 'and none is listed');
    });
}
