/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A program presenting faster than its device can draw is held at Present, as
 * a Windows driver holds it, and only the presenting thread is: the program's
 * other threads run while it waits.
 *
 * The program makes a Direct3D 8 device and a second thread that does nothing
 * but count, then clears and presents twelve frames, noting how far the
 * counter moved during each Present. The device is a stand-in whose work
 * finishes one submit every few milliseconds of the host's timers, far slower
 * than the program presents. With the default bound the device is never more
 * than one frame past the bound behind, some presents wait, and the counter
 * moves while they do -- a Present that answers at once is one host call, in
 * which no other thread can run. With no bound the program runs ahead of the
 * device and no present waits.
 *
 * The program exits 0; its report is the counter's movement during presents
 * and the number of presents that did not answer D3D_OK.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** Frames the program presents. */
const FRAMES = 12;

function buildPresentingExe(){
    const D3DFMT_X8R8G8B8 = 22;
    const D3DCLEAR_TARGET = 1;
    const WS_OVERLAPPEDWINDOW = 0x00cf0000;
    const IDirect3D8_CreateDevice = 3 + 12;
    const IDirect3DDevice8_Present = 3 + 12;
    const IDirect3DDevice8_Clear = 3 + 33;
    // The counting thread's body, at a fixed offset of the code so the main
    // body can name it before it is laid out.
    const WORKER_OFFSET = 0x380;

    return buildExe({
        imports: {
            'USER32.dll': ['RegisterClassA', 'CreateWindowExA', 'DefWindowProcA'],
            'D3D8.dll': ['Direct3DCreate8'],
            'KERNEL32.dll': ['CreateThread', 'GetStdHandle', 'WriteFile', 'ExitProcess'],
        },
        codeSize: 0x400,
        data: {
            className: [...Buffer.from('BottlifyLatency'), 0],
            wndclass: new Array(40).fill(0),
            // D3DPRESENT_PARAMETERS: 64x64 windowed, the window filled in later.
            present: [
                ...u32(64), ...u32(64), ...u32(D3DFMT_X8R8G8B8), ...u32(1), ...u32(0), ...u32(1),
                ...u32(0), ...u32(1), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
            ],
            device: u32(0),
            counter: u32(0),
            before: u32(0),
            // What the program reports: the counter's movement during its
            // presents, and how many presents did not answer D3D_OK.
            report: [...u32(0), ...u32(0)],
            written: u32(0),
        },
        code: ({ iat, at, code })=>{
            /** @param {number} value */
            const push = value=>[0x68, ...u32(value)];
            /** A method of the interface in ESI, its arguments right to left. */
            const method = (/** @type {number} */ slot, /** @type {number[][]} */ args)=>[
                ...args.slice().reverse().flat(),
                0x56, //                                     push esi
                0x8b, 0x06, //                               mov eax, [esi]
                0xff, 0x90, ...u32(slot * 4), //             call [eax + slot*4]
            ];
            const frame = [
                // Clear(0, NULL, D3DCLEAR_TARGET, EBX as the colour, 0.0f, 0)
                ...method(IDirect3DDevice8_Clear, [
                    push(0), push(0), push(D3DCLEAR_TARGET), [0x53], push(0), push(0),
                ]),
                0xa1, ...u32(at('counter')), //              mov eax, [counter]
                0xa3, ...u32(at('before')), //               mov [before], eax
                ...method(IDirect3DDevice8_Present, [push(0), push(0), push(0), push(0)]),
                0x85, 0xc0, //                               test eax, eax
                0x74, 0x06, //                               jz +6
                0xff, 0x05, ...u32(at('report') + 4), //     inc dword [report.failed]
                0xa1, ...u32(at('counter')), //              mov eax, [counter]
                0x2b, 0x05, ...u32(at('before')), //         sub eax, [before]
                0x01, 0x05, ...u32(at('report')), //         add [report.moved], eax
                0x4b, //                                     dec ebx
            ];
            const loop = [...frame, 0x0f, 0x85, ...u32(-(frame.length + 6))]; // jnz frame
            const main = [
                0xa1, ...u32(iat('DefWindowProcA')), //      wndclass.lpfnWndProc
                0xa3, ...u32(at('wndclass') + 4),
                0xc7, 0x05, ...u32(at('wndclass') + 36), ...u32(at('className')),
                ...push(at('wndclass')),
                0xff, 0x15, ...u32(iat('RegisterClassA')),
                // CreateWindowExA(0, className, className, WS_OVERLAPPEDWINDOW,
                //                 0, 0, 64, 64, 0, 0, 0, 0)
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                ...push(64), ...push(64), 0x6a, 0x00, 0x6a, 0x00,
                ...push(WS_OVERLAPPEDWINDOW), ...push(at('className')), ...push(at('className')),
                0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateWindowExA')),
                0xa3, ...u32(at('present') + 0x18), //       present.hDeviceWindow = hWnd
                0x50, //                                     push eax (the focus window)
                0x5f, //                                     pop edi
                ...push(220),
                0xff, 0x15, ...u32(iat('Direct3DCreate8')),
                0x89, 0xc6, //                               mov esi, eax
                // CreateDevice(0, D3DDEVTYPE_HAL, hWnd, SOFTWARE_VERTEXPROCESSING,
                //              &present, &device)
                ...method(IDirect3D8_CreateDevice, [
                    push(0), push(1), [0x57], push(0x20), push(at('present')), push(at('device')),
                ]),
                0x8b, 0x35, ...u32(at('device')), //         mov esi, [device]
                // CreateThread(NULL, 0, worker, NULL, 0, NULL)
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                ...push(code(WORKER_OFFSET)),
                0x6a, 0x00, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateThread')),
                0xbb, ...u32(FRAMES), //                     mov ebx, FRAMES
                ...loop,
                // WriteFile(GetStdHandle(-11), report, 8, &written, NULL)
                0x6a, 0xf5,
                0xff, 0x15, ...u32(iat('GetStdHandle')),
                0x6a, 0x00, ...push(at('written')), 0x6a, 0x08, ...push(at('report')), 0x50,
                0xff, 0x15, ...u32(iat('WriteFile')),
                0x6a, 0x00,
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
            if (main.length > WORKER_OFFSET)
            {
                throw new Error(`main body is ${main.length} bytes, past the worker`);
            }
            return [
                ...main, ...new Array(WORKER_OFFSET - main.length).fill(0xcc),
                0xff, 0x05, ...u32(at('counter')), //        inc dword [counter]
                0xeb, 0xf8, //                               jmp to the inc
            ];
        },
    });
}

/**
 * Runs the program over a device that finishes one submit every few
 * milliseconds.
 *
 * @param {number | undefined} maxFrameLatency
 * @param {'cork' | 'emulator'} engine
 */
async function run(maxFrameLatency, engine){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const gpu = createFakeDevice({ workDone: true });
    const gpuDevice = /** @type {any} */ (gpu.device);
    gpuDevice.features = new Set();
    gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor });
    const pace = setInterval(()=>gpu.finish(1), 3);
    const app = await createApp({
        executable: buildPresentingExe(),
        engine,
        device: {
            device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
            adapter: { vendor: 'fake', architecture: '', description: 'a stand-in' },
        },
        graphics: { maxFrameLatency },
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
    });
    try
    {
        /** @type {number[]} */
        const bytes = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>{
            for (const character of text)
            {
                bytes.push(character.charCodeAt(0));
            }
        });
        const code = await app.run({ timeoutMs: 30000 });
        const dword = (/** @type {number} */ at)=>(bytes[at] | bytes[at + 1] << 8
            | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;
        const graphics = app.diagnostics().find((/** @type {any} */ layer)=>
            layer.name === 'graphics');
        return {
            code,
            moved: bytes.length >= 8 ? dword(0) : null,
            failed: bytes.length >= 8 ? dword(4) : null,
            latency: graphics?.metrics?.presenter?.latency ?? null,
        };
    }
    finally
    {
        clearInterval(pace);
        await app.dispose();
    }
}

for (const engine of /** @type {const} */ (['cork', 'emulator']))
{
    test(`a program presenting faster than its device waits at Present while its other threads`
        + ` run, under ${engine}`, { timeout: 60000 }, async t=>{
        const bound = await run(undefined, engine);
        t.diagnostic(`bound: ${JSON.stringify(bound)}`);
        assert.equal(bound.code, 0);
        assert.equal(bound.failed, 0, 'every present answered D3D_OK');
        assert.ok(bound.latency, 'the run presenter counts frames in flight');
        assert.equal(bound.latency.limit, 3, 'three by default');
        assert.equal(bound.latency.frames, FRAMES);
        assert.ok(bound.latency.held > 0, 'presents waited for the device');
        assert.ok(bound.latency.peak <= 4,
            `the device was never more than the bound and the waiting frame behind (${
                bound.latency.peak})`);
        assert.ok(/** @type {number} */ (bound.moved) > 0,
            'the counting thread ran while a present waited');
    });

    test(`with no bound the program runs ahead of its device and no present waits, under ${
        engine}`, { timeout: 60000 }, async t=>{
        const free = await run(0, engine);
        t.diagnostic(`free: ${JSON.stringify(free)}`);
        assert.equal(free.code, 0);
        assert.equal(free.failed, 0);
        // No present waited. The counting thread may still have run: an
        // interpreted slice also ends on time, whatever the presents do.
        assert.equal(free.latency?.held, 0);
        assert.ok(free.latency.peak > 4, `${free.latency.peak} frames behind at most`);
    });
}
