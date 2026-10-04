/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A back buffer read back for the program comes into guest memory from the
 * graphics worker -- in place, where the memory is shared, and through a
 * message the engine writes, where it is not -- and the program reads the
 * colour it cleared to either way.
 *
 * The program clears the back buffer, ends the scene, locks the back buffer
 * to read, takes its first pixel and exits with it. The device is played in
 * a worker thread over the fake GPU, as the browser's graphics worker plays it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createApp } from './app.js';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';
import { IDIRECT3DDEVICE9_SLOTS, IDIRECT3DSURFACE9_SLOTS } from './layers/graphics/d3d9/interfaces.js';
import { IDIRECT3D9_SLOTS } from './layers/graphics/seam/vtables.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const COLOUR = 0x00336699;

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {[string, number][]} slots @param {string} name */
const slotIn = (slots, name)=>3 + slots.findIndex(([entry])=>entry === name);

function program(){
    return buildExe({
        imports: {
            'USER32.dll': ['RegisterClassA', 'CreateWindowExA', 'DefWindowProcA'],
            'D3D9.dll': ['Direct3DCreate9'],
            'KERNEL32.dll': ['ExitProcess'],
        },
        codeSize: 0x400,
        data: {
            className: [...Buffer.from('BottlifyReadBack'), 0],
            wndclass: new Array(40).fill(0),
            // 64x32 X8R8G8B8, windowed, D3DPRESENTFLAG_LOCKABLE_BACKBUFFER.
            present: [...u32(64), ...u32(32), ...u32(22), ...u32(1), ...u32(0), ...u32(0),
                ...u32(1), ...u32(0), ...u32(1), ...u32(0), ...u32(0), ...u32(1), ...u32(0),
                ...u32(0)],
            device: u32(0),
            back: u32(0),
            locked: [...u32(0), ...u32(0)],
        },
        code: ({ iat, at })=>{
            /** @param {number} value */
            const push = value=>[0x68, ...u32(value)];
            /** A method of the interface in ESI, `this` pushed last. */
            const call = (/** @type {number} */ slot, /** @type {number[][]} */ args = [])=>[
                ...args.slice().reverse().flat(),
                0x56, 0x8b, 0x06, 0xff, 0x90, ...u32(slot * 4),
            ];
            const device = (/** @type {string} */ name, /** @type {number[][]} */ args = [])=>
                call(slotIn(IDIRECT3DDEVICE9_SLOTS, name), args);
            const surface = (/** @type {string} */ name, /** @type {number[][]} */ args = [])=>
                call(name === 'Release' ? 2 : slotIn(IDIRECT3DSURFACE9_SLOTS, name), args);
            return [
                0xa1, ...u32(iat('DefWindowProcA')), 0xa3, ...u32(at('wndclass') + 4),
                0xc7, 0x05, ...u32(at('wndclass') + 36), ...u32(at('className')),
                ...push(at('wndclass')), 0xff, 0x15, ...u32(iat('RegisterClassA')),
                ...push(0), ...push(0), ...push(0), ...push(0), ...push(32), ...push(64),
                ...push(0), ...push(0), ...push(0x00cf0000), ...push(at('className')),
                ...push(at('className')), ...push(0), 0xff, 0x15, ...u32(iat('CreateWindowExA')),
                0xa3, ...u32(at('present') + 28), //        present.hDeviceWindow = hWnd
                0x89, 0xc7, //                              mov edi, eax
                ...push(32), 0xff, 0x15, ...u32(iat('Direct3DCreate9')),
                0x89, 0xc6, //                              mov esi, eax
                ...call(slotIn(IDIRECT3D9_SLOTS, 'CreateDevice'), [push(0), push(1), [0x57],
                    push(0x20), push(at('present')), push(at('device'))]),
                0x8b, 0x35, ...u32(at('device')), //        mov esi, [device]
                // Clear(0, NULL, D3DCLEAR_TARGET, COLOUR, 1.0, 0)
                ...device('Clear', [push(0), push(0), push(1), push(0xff000000 | COLOUR),
                    push(0x3f800000), push(0)]),
                ...device('BeginScene'),
                ...device('EndScene'),
                ...device('GetBackBuffer', [push(0), push(0), push(0), push(at('back'))]),
                0x8b, 0x35, ...u32(at('back')), //          mov esi, [back]
                // LockRect(&locked, NULL, D3DLOCK_READONLY)
                ...surface('LockRect', [push(at('locked')), push(0), push(0x10)]),
                0x8b, 0x1d, ...u32(at('locked') + 4), //    mov ebx, [locked.pBits]
                0x8b, 0x1b, //                              mov ebx, [ebx]
                ...surface('UnlockRect'),
                ...surface('Release'),
                0x81, 0xe3, ...u32(0x00ffffff), //          and ebx, 0xffffff
                0x53, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
        },
    });
}

/** @param {boolean} shared */
async function run(shared){
    const gpu = createFakeDevice();
    const gpuDevice = /** @type {any} */ (gpu.device);
    gpuDevice.features = new Set();
    gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor });
    const thread = new Worker(new URL('../../../tools/fake-graphics-worker.mjs', import.meta.url));
    thread.postMessage({ type: 'open', frames: 'none' });
    /** @type {Map<Function, (data: any) => void>} */
    const listeners = new Map();
    const worker = {
        postMessage: (/** @type {any} */ message, /** @type {any} */ transfer)=>
            thread.postMessage(message, transfer),
        addEventListener: (/** @type {string} */ type, /** @type {Function} */ listener)=>{
            const relay = (/** @type {any} */ data)=>listener({ data });
            listeners.set(listener, relay);
            thread.on('message', relay);
        },
        removeEventListener: (/** @type {string} */ type, /** @type {Function} */ listener)=>{
            thread.off('message', /** @type {any} */ (listeners.get(listener)));
        },
    };
    try
    {
        const app = await createApp({
            executable: program(),
            cork: /** @type {any} */ ({ config: { sharedMemory: shared } }),
            device: {
                device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
                adapter: { vendor: 'fake', architecture: '', description: 'a stand-in' },
                worker,
            },
        });
        const code = await app.run({ timeoutMs: 50000 });
        const diagnostics = app.diagnostics();
        /** @param {string} name */
        const metrics = name=>diagnostics.find((/** @type {any} */ layer)=>layer.name === name)
            ?.metrics;
        const result = { code, sharedMemory: metrics('cpu')?.sharedMemory,
            readBack: metrics('graphics')?.worker?.readBack };
        await app.dispose();
        return result;
    }
    finally
    {
        await thread.terminate();
    }
}

test('a back buffer read back is written into shared guest memory in place', { timeout: 60000 },
    async()=>{
        const result = await run(true);
        assert.equal(result.sharedMemory, true);
        assert.equal(result.code, COLOUR, 'the program read the colour it cleared to');
        assert.ok(result.readBack.shared >= 64 * 32 * 4, JSON.stringify(result.readBack));
        assert.equal(result.readBack.sent, 0, 'and none of it came as a message');
    });

test('a back buffer read back comes as a message where guest memory is not shared',
    { timeout: 60000 }, async()=>{
        const result = await run(false);
        assert.equal(result.sharedMemory, false);
        assert.equal(result.code, COLOUR);
        assert.ok(result.readBack.sent >= 64 * 32 * 4, JSON.stringify(result.readBack));
        assert.equal(result.readBack.shared, 0);
    });
