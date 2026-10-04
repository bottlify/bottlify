/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a program unlocks is lent to the graphics worker where guest memory is
 * shared -- the worker reads it in place -- and copied to it where it is not,
 * or where lending is turned off.
 *
 * The program locks a texture each frame, fills it, unlocks it, draws with
 * it and presents, then exits. The device is played in a worker thread over
 * the fake GPU, as the browser's graphics worker plays it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createApp } from './app.js';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';
import { IDIRECT3DDEVICE9_SLOTS, IDIRECT3DTEXTURE9_SLOTS } from './layers/graphics/d3d9/interfaces.js';
import { IDIRECT3D9_SLOTS } from './layers/graphics/seam/vtables.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const FRAMES = 3;

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
            className: [...Buffer.from('BottlifyLend'), 0],
            wndclass: new Array(40).fill(0),
            present: [...u32(64), ...u32(32), ...u32(22), ...u32(1), ...u32(0), ...u32(0),
                ...u32(1), ...u32(0), ...u32(1), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
                ...u32(0)],
            device: u32(0),
            texture: u32(0),
            frames: u32(FRAMES),
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
            const device = (/** @type {string} */ name, /** @type {number[][]} */ args = [])=>[
                0x8b, 0x35, ...u32(at('device')), //        mov esi, [device]
                ...call(slotIn(IDIRECT3DDEVICE9_SLOTS, name), args),
            ];
            const texture = (/** @type {string} */ name, /** @type {number[][]} */ args = [])=>[
                0x8b, 0x35, ...u32(at('texture')), //       mov esi, [texture]
                ...call(slotIn(IDIRECT3DTEXTURE9_SLOTS, name), args),
            ];
            const frame = [
                // LockRect(0, &locked, NULL, 0); fill it with the frames left; UnlockRect(0)
                ...texture('LockRect', [push(0), push(at('locked')), push(0), push(0)]),
                0x8b, 0x3d, ...u32(at('locked') + 4), //    mov edi, [locked.pBits]
                0xa1, ...u32(at('frames')), //              mov eax, [frames]
                0xb9, ...u32(64 * 64), //                   mov ecx, 64*64
                0xf3, 0xab, //                              rep stosd
                ...texture('UnlockRect', [push(0)]),
                ...device('SetTexture', [push(0), [0xff, 0x35, ...u32(at('texture'))]]),
                ...device('BeginScene'),
                ...device('EndScene'),
                ...device('Present', [push(0), push(0), push(0), push(0)]),
                0xff, 0x0d, ...u32(at('frames')), //        dec dword [frames]
            ];
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
                // CreateTexture(64, 64, 1, 0, A8R8G8B8, MANAGED, &texture, NULL)
                ...device('CreateTexture', [push(64), push(64), push(1), push(0), push(21),
                    push(1), push(at('texture')), push(0)]),
                ...frame,
                0x0f, 0x85, ...u32(-(frame.length + 6)), // jnz frame
                ...push(0), 0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
        },
    });
}

/** @param {boolean} shared @param {boolean} lend @param {any} [mode] */
async function run(shared, lend, mode){
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
            graphics: /** @type {any} */ ({ lendMemory: lend }),
            ...mode ? { mode } : {},
            device: {
                device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
                adapter: { vendor: 'fake', architecture: '', description: 'a stand-in' },
                worker,
            },
        });
        /** @type {string[]} */
        const divergences = [];
        app.on('divergence', (/** @type {any} */ seen)=>divergences.push(seen.detail));
        const code = await app.run({ timeoutMs: 50000 });
        const layers = app.diagnostics();
        const metrics = layers.find((/** @type {any} */ layer)=>layer.name === 'graphics')?.metrics;
        const result = { code, divergences, lent: metrics?.worker?.lent,
            mode: layers.find((/** @type {any} */ layer)=>layer.name === 'app')?.metrics?.mode };
        await app.dispose();
        return result;
    }
    finally
    {
        await thread.terminate();
    }
}

test('a texture unlocked each frame is lent to the graphics worker where memory is shared',
    { timeout: 60000 }, async()=>{
        const result = await run(true, true);
        assert.equal(result.mode, 'full', 'auto, where memory can be shared');
        assert.equal(result.code, 0);
        assert.deepEqual(result.divergences, []);
        assert.equal(result.lent.lent, FRAMES, JSON.stringify(result.lent));
        assert.equal(result.lent.lentBytes, FRAMES * 64 * 64 * 4);
    });

test('a texture unlocked each frame is copied where memory is not shared, lending is off, or'
    + ' the run is in safe mode', { timeout: 90000 }, async()=>{
    for (const [shared, lend, mode] of [[false, true], [true, false], [true, true, 'safe']])
    {
        const result = await run(/** @type {boolean} */ (shared), /** @type {boolean} */ (lend),
            mode);
        assert.equal(result.code, 0);
        assert.deepEqual(result.divergences, []);
        assert.deepEqual(result.lent, {}, `shared ${shared}, lend ${lend}, mode ${mode}`);
        if (mode)
        {
            assert.equal(result.mode, 'safe');
        }
    }
});
