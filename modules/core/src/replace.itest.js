/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A replacement is invisible to whoever is reading the log.
 *
 * A parent that starts a child and then exits hands its process over: the
 * machine is torn down and rebuilt on the child's image. Everything the reader
 * holds -- the level it raised at run time, the cursor it drains from, the sink
 * it attached -- has to survive that, or the call log simply stops at the
 * handover and the child runs unobserved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';
import { buildExe } from '../../../tools/make-pe.mjs';

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

test('the reader keeps its level, its cursor and its sink across a replacement', async t=>{
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    // The decoder binary is fetched, not tracked; without it this test still
    // exercises the replacement, and the instance sharing below is skipped.
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
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
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
    /** What `process-replace` said the parent's journal had reached. */
    let replacedAt = 0;
    app.on('process-replace', ()=>{
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
    // page was handed for its worklet. A little of the parent's sound is put
    // in and taken out, so the cursor the reader holds is not at zero.
    const ring = app.audio.ring();
    const before = ring.memory;
    ring.write(new Float32Array([1, 1, 2, 2]));
    assert.equal(ring.read(new Float32Array(4)), 2, 'the reader took the parent\'s sound');
    const consumed = ring.consumed();
    assert.ok(consumed > 0, 'the reader is not at the start of the ring');

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

    const code = await app.run({ timeoutMs: 20000 });
    assert.equal(code, 0, 'the child exited cleanly');

    // The same presenter, now attached to the child's machine: the count
    // continues rather than restarting, and the canvas was not configured again
    // at the swap -- a reconfigure clears it, which is the black frame.
    presenter.present(surface);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(app.presenter(), presenter, 'the run kept the presenter it made');
    assert.equal(presenter.diagnostics().presents, 2, 'the count continued across the replacement');
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
    assert.equal(announced.sequenceBase, replacedAt,
        'the child continues the sequence the parent reached');
    assert.ok(after.records.some((/** @type {any} */ record)=>
        record.sequence === announced.sequenceBase),
    'and the child\'s journal actually starts at that base');

    // The sink attached before the handover was still the one detachLog knew.
    assert.deepEqual(output, ['A'],
        'detaching after the replacement stopped the sink receiving');

    // The child's machine mixes into the output the reader already holds,
    // rather than making a ring of its own that nobody would read.
    const childRing = app.audio.ring();
    assert.equal(childRing.memory.control, before.control, 'the same control block');
    assert.equal(childRing.memory.samples, before.samples, 'the same samples');
    assert.equal(childRing.consumed(), consumed, 'the read cursor continued, not reset');

    childRing.write(new Float32Array([3, 3]));
    assert.equal(childRing.read(new Float32Array(2)), 1, 'the child writes into the same ring');
    assert.equal(childRing.consumed(), consumed + 1, 'and the reader keeps counting');

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
