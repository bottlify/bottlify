/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every pointer a Direct3D 9 lock hands a program is on a 16-byte boundary,
 * through the app's own allocator: a texture's level, a dynamic vertex
 * buffer's first storage, and the other storages a DISCARD under a pending
 * draw moves the buffer onto (`d3d8/storages.js`). A program that writes a
 * locked buffer with SSE stores checks the pointer, and given one off the
 * boundary unlocks and leaves out of the frame what it would have written.
 *
 * The program makes a 1x1 texture and a dynamic vertex buffer of an odd length
 * by turns, which leaves the heap's next block eight bytes off the boundary
 * when nothing aligns it, then draws from each buffer and locks it with
 * DISCARD, round after round, so the device moves it between its storages. It
 * exits with every pointer's low four bits or-ed together.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';
import { IDIRECT3DDEVICE9_SLOTS, IDIRECT3DTEXTURE9_SLOTS, IDIRECT3DVERTEXBUFFER9_SLOTS }
    from './layers/graphics/d3d9/interfaces.js';
import { IDIRECT3D9_SLOTS } from './layers/graphics/seam/vtables.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** Buffers and textures the program makes. */
const BUFFERS = 6;
/** Rounds of draw, DISCARD and unlock over every buffer. */
const ROUNDS = 40;

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {[string, number][]} slots @param {string} name */
const slotIn = (slots, name)=>3 + slots.findIndex(([entry])=>entry === name);

function program(){
    const D3DFMT_A8R8G8B8 = 21;
    const D3DPOOL_MANAGED = 1;
    const D3DUSAGE_DYNAMIC_WRITEONLY = 0x208;
    const D3DFVF_XYZ = 2;
    const D3DPT_TRIANGLELIST = 4;
    const D3DLOCK_DISCARD = 0x2000;
    return buildExe({
        imports: {
            'USER32.dll': ['RegisterClassA', 'CreateWindowExA', 'DefWindowProcA'],
            'D3D9.dll': ['Direct3DCreate9'],
            'KERNEL32.dll': ['ExitProcess'],
        },
        codeSize: 0x600,
        data: {
            className: [...Buffer.from('BottlifyAlign'), 0],
            wndclass: new Array(40).fill(0),
            present: [...u32(64), ...u32(64), ...u32(21), ...u32(1), ...u32(0), ...u32(0),
                ...u32(1), ...u32(0), ...u32(1), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
                ...u32(0)],
            device: u32(0),
            texture: u32(0),
            buffers: new Array(BUFFERS * 4).fill(0),
            // D3DLOCKED_RECT: Pitch, pBits.
            rect: new Array(8).fill(0),
            locked: u32(0),
            bits: u32(0),
        },
        code: ({ iat, at })=>{
            /** @param {number} value */
            const push = value=>[0x68, ...u32(value)];
            /** A method through the interface in a register, `this` pushed last. */
            const call = (/** @type {number} */ thisPush, /** @type {number} */ thisLoad,
                /** @type {number} */ slot, /** @type {number[][]} */ args = [])=>[
                ...args.slice().reverse().flat(),
                thisPush, //                                push reg
                0x8b, thisLoad, //                          mov eax, [reg]
                0xff, 0x90, ...u32(slot * 4), //            call [eax + slot*4]
            ];
            const device = (/** @type {string} */ name, /** @type {number[][]} */ args = [])=>
                call(0x56, 0x06, slotIn(IDIRECT3DDEVICE9_SLOTS, name), args); //  this = esi
            const onBuffer = (/** @type {string} */ name, /** @type {number[][]} */ args = [])=>
                call(0x53, 0x03, slotIn(IDIRECT3DVERTEXBUFFER9_SLOTS, name), args); // ebx
            const onTexture = (/** @type {string} */ name, /** @type {number[][]} */ args = [])=>
                call(0x53, 0x03, slotIn(IDIRECT3DTEXTURE9_SLOTS, name), args); //   ebx
            /** A pointer's low four bits or-ed into [bits]. */
            const fold = (/** @type {number} */ address)=>[
                0xa1, ...u32(address), //                   mov eax, [address]
                0x83, 0xe0, 0x0f, //                        and eax, 15
                0x09, 0x05, ...u32(at('bits')), //          or [bits], eax
            ];
            const make = [
                // CreateTexture(1, 1, 1, 0, A8R8G8B8, MANAGED, &texture, NULL): four bytes
                ...device('CreateTexture', [push(1), push(1), push(1), push(0),
                    push(D3DFMT_A8R8G8B8), push(D3DPOOL_MANAGED), push(at('texture')), push(0)]),
                0x8b, 0x1d, ...u32(at('texture')), //       mov ebx, [texture]
                ...onTexture('LockRect', [push(0), push(at('rect')), push(0), push(0)]),
                ...fold(at('rect') + 4),
                ...onTexture('UnlockRect', [push(0)]),
                // CreateVertexBuffer(36 + 8 * ebp, DYNAMIC | WRITEONLY, XYZ, DEFAULT,
                //     &buffers[ebp], NULL)
                ...device('CreateVertexBuffer', [
                    [0x8d, 0x04, 0xed, ...u32(36), 0x50], // lea eax, [ebp*8 + 36]; push eax
                    push(D3DUSAGE_DYNAMIC_WRITEONLY), push(D3DFVF_XYZ), push(0),
                    [0x8d, 0x04, 0xad, ...u32(at('buffers')), 0x50], // lea eax, [buffers + ebp*4]
                    push(0)]),
                0x45, //                                    inc ebp
                0x83, 0xfd, BUFFERS, //                     cmp ebp, BUFFERS
            ];
            const each = [
                0x8b, 0x1c, 0xad, ...u32(at('buffers')), // mov ebx, [buffers + ebp*4]
                ...device('SetStreamSource', [push(0), [0x53], push(0), push(12)]),
                ...device('DrawPrimitive', [push(D3DPT_TRIANGLELIST), push(0), push(1)]),
                ...onBuffer('Lock', [push(0), push(0), push(at('locked')), push(D3DLOCK_DISCARD)]),
                ...fold(at('locked')),
                ...onBuffer('Unlock'),
                0x45, //                                    inc ebp
                0x83, 0xfd, BUFFERS, //                     cmp ebp, BUFFERS
            ];
            const round = [
                0x31, 0xed, //                              xor ebp, ebp
                ...each,
                0x0f, 0x82, ...u32(-(each.length + 6)), //  jb each
                0x4f, //                                    dec edi
            ];
            return [
                0xa1, ...u32(iat('DefWindowProcA')), 0xa3, ...u32(at('wndclass') + 4),
                0xc7, 0x05, ...u32(at('wndclass') + 36), ...u32(at('className')),
                ...push(at('wndclass')), 0xff, 0x15, ...u32(iat('RegisterClassA')),
                ...push(0), ...push(0), ...push(0), ...push(0), ...push(64), ...push(64),
                ...push(0), ...push(0), ...push(0), ...push(0x00cf0000), ...push(at('className')),
                ...push(at('className')), ...push(0), 0xff, 0x15, ...u32(iat('CreateWindowExA')),
                0xa3, ...u32(at('present') + 28), //        present.hDeviceWindow = hWnd
                0x89, 0xc7, //                              mov edi, eax
                ...push(32), 0xff, 0x15, ...u32(iat('Direct3DCreate9')),
                0x89, 0xc6, //                              mov esi, eax
                // CreateDevice(0, HAL, hWnd, SOFTWARE_VERTEXPROCESSING, &present, &device)
                ...call(0x56, 0x06, slotIn(IDIRECT3D9_SLOTS, 'CreateDevice'), [push(0), push(1),
                    [0x57], push(0x20), push(at('present')), push(at('device'))]),
                0x8b, 0x35, ...u32(at('device')), //        mov esi, [device]
                0x31, 0xed, //                              xor ebp, ebp
                ...make,
                0x0f, 0x82, ...u32(-(make.length + 6)), //  jb make
                ...device('SetFVF', [push(D3DFVF_XYZ)]),
                ...device('BeginScene'),
                0xbf, ...u32(ROUNDS), //                    mov edi, ROUNDS
                ...round,
                0x0f, 0x85, ...u32(-(round.length + 6)), // jnz round
                ...device('EndScene'),
                0xff, 0x35, ...u32(at('bits')), //          push dword [bits]
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
        },
    });
}

/**
 * The first `moved` figures in a diagnostics tree: the device's moves onto
 * other storages (`seam/shadow.js`).
 *
 * @param {any} node
 * @returns {{ made: number, storages: number } | null}
 */
const movesIn = node=>{
    if (!node || typeof node !== 'object')
    {
        return null;
    }
    if (node.moved && typeof node.moved.made === 'number')
    {
        return node.moved;
    }
    for (const value of Object.values(node))
    {
        const found = movesIn(value);
        if (found)
        {
            return found;
        }
    }
    return null;
};

test('a lock hands a program a pointer on a 16-byte boundary, on every storage of a buffer',
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
            const bits = await app.run({ timeoutMs: 50000 });
            assert.equal(bits, 0, `the low four bits of the pointers handed out: 0x${
                (bits >>> 0).toString(16)}`);
            const graphics = app.diagnostics().find((/** @type {any} */ layer)=>
                layer.name === 'graphics');
            const moved = movesIn(graphics?.metrics?.shadow);
            assert.ok(moved && moved.storages > 0 && moved.made > 0,
                `the buffers moved between storages: ${JSON.stringify(moved)}`);
        }
        finally
        {
            await app.dispose();
        }
    });
