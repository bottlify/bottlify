/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The references a program takes and gives back on a Direct3D 9 texture and
 * its level, with every answer checked, come to the host only when the count
 * crosses zero: the guest's AddRef and Release (`bridge/internal/vtable.js`)
 * answer the rest from the word the count is kept in, and the host's own
 * references -- a level handed out -- land in the same word.
 *
 * The program makes a texture of two levels and loops: AddRef the texture,
 * ask for its second level (a reference the host takes), AddRef the level and
 * give back two references through it and one through the texture, checking
 * each count it is answered against the one it owes. Then it gives back the
 * last reference and exits with how many answers were wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';
import { IDIRECT3DDEVICE9_SLOTS, IDIRECT3DTEXTURE9_SLOTS } from './layers/graphics/d3d9/interfaces.js';
import { IDIRECT3D9_SLOTS } from './layers/graphics/seam/vtables.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const ITERATIONS = 3000;

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
            className: [...Buffer.from('BottlifyRefs'), 0],
            wndclass: new Array(40).fill(0),
            present: [...u32(64), ...u32(64), ...u32(21), ...u32(1), ...u32(0), ...u32(0),
                ...u32(1), ...u32(0), ...u32(1), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
                ...u32(0)],
            device: u32(0),
            texture: u32(0),
            level: u32(0),
            wrong: u32(0),
        },
        code: ({ iat, at })=>{
            /** @param {number} value */
            const push = value=>[0x68, ...u32(value)];
            /** A method through the interface in `register`'s code, `this` pushed last. */
            const call = (/** @type {number} */ thisPush, /** @type {number} */ thisLoad,
                /** @type {number} */ slot, /** @type {number[][]} */ args = [])=>[
                ...args.slice().reverse().flat(),
                thisPush, //                                push reg
                0x8b, thisLoad, //                          mov eax, [reg]
                0xff, 0x90, ...u32(slot * 4), //            call [eax + slot*4]
            ];
            const onTexture = (/** @type {string} */ name, /** @type {number[][]} */ args = [])=>
                call(0x53, 0x03, name === 'AddRef' ? 1 : name === 'Release' ? 2
                    : slotIn(IDIRECT3DTEXTURE9_SLOTS, name), args); //  this = ebx
            const onLevel = (/** @type {string} */ name)=>
                call(0x56, 0x06, name === 'AddRef' ? 1 : 2); //       this = esi
            /** The answer in EAX against the count owed; a wrong one is counted. */
            const owed = (/** @type {number} */ count)=>[
                0x83, 0xf8, count, //                       cmp eax, count
                0x74, 0x06, //                              je +6
                0xff, 0x05, ...u32(at('wrong')), //         inc dword [wrong]
            ];
            const iteration = [
                ...onTexture('AddRef'), ...owed(2),
                ...onTexture('GetSurfaceLevel', [push(1), push(at('level'))]), ...owed(0),
                0x8b, 0x35, ...u32(at('level')), //         mov esi, [level]
                ...onLevel('AddRef'), ...owed(4),
                ...onLevel('Release'), ...owed(3),
                ...onLevel('Release'), ...owed(2),
                ...onTexture('Release'), ...owed(1),
                0x4f, //                                    dec edi
            ];
            const device = (/** @type {string} */ name, /** @type {number[][]} */ args)=>
                call(0x56, 0x06, slotIn(IDIRECT3DDEVICE9_SLOTS, name), args);
            return [
                0xa1, ...u32(iat('DefWindowProcA')), 0xa3, ...u32(at('wndclass') + 4),
                0xc7, 0x05, ...u32(at('wndclass') + 36), ...u32(at('className')),
                ...push(at('wndclass')), 0xff, 0x15, ...u32(iat('RegisterClassA')),
                ...push(0), ...push(0), ...push(0), ...push(0), ...push(64), ...push(64),
                ...push(0), ...push(0), ...push(0x00cf0000), ...push(at('className')),
                ...push(at('className')), ...push(0), 0xff, 0x15, ...u32(iat('CreateWindowExA')),
                0xa3, ...u32(at('present') + 28), //        present.hDeviceWindow = hWnd
                0x89, 0xc7, //                              mov edi, eax
                ...push(32), 0xff, 0x15, ...u32(iat('Direct3DCreate9')),
                0x89, 0xc6, //                              mov esi, eax
                // CreateDevice(0, HAL, hWnd, SOFTWARE_VERTEXPROCESSING, &present, &device)
                ...call(0x56, 0x06, slotIn(IDIRECT3D9_SLOTS, 'CreateDevice'), [push(0), push(1),
                    [0x57], push(0x20), push(at('present')), push(at('device'))]),
                0x8b, 0x35, ...u32(at('device')), //        mov esi, [device]
                // CreateTexture(64, 64, 2, 0, A8R8G8B8, MANAGED, &texture, NULL)
                ...device('CreateTexture', [push(64), push(64), push(2), push(0), push(21),
                    push(1), push(at('texture')), push(0)]),
                0x8b, 0x1d, ...u32(at('texture')), //       mov ebx, [texture]
                0xbf, ...u32(ITERATIONS), //                mov edi, ITERATIONS
                ...iteration,
                0x0f, 0x85, ...u32(-(iteration.length + 6)), // jnz loop
                ...onTexture('Release'), ...owed(0),
                0xff, 0x35, ...u32(at('wrong')), //         push dword [wrong]
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
        },
    });
}

test('references not crossing zero are taken and given back in the guest, each answered right',
    { timeout: 60000 }, async()=>{
        const gpu = createFakeDevice();
        const gpuDevice = /** @type {any} */ (gpu.device);
        gpuDevice.features = new Set();
        gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler',
            descriptor });
        const app = await createApp({
            executable: program(),
            device: {
                device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
                adapter: { vendor: 'fake', architecture: '', description: 'a stand-in' },
            },
        });
        try
        {
            assert.equal(await app.run({ timeoutMs: 50000 }), 0, 'every count answered was owed');
            const bridge = app.diagnostics().find((/** @type {any} */ layer)=>
                layer.name === 'bridge');
            /** @type {string[]} */
            const byFunction = bridge?.metrics?.byFunction ?? [];
            const crossings = byFunction
                .filter(line=>/::(AddRef|Release) /.test(line))
                .reduce((sum, line)=>sum + Number(line.split(' ')[1]), 0);
            assert.ok(crossings < 10, `${crossings} AddRef and Release calls reached the host`
                + ` of ${ITERATIONS * 5 + 1}`);
        }
        finally
        {
            await app.dispose();
        }
    });
