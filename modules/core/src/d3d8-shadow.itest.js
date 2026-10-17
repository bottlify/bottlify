/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a Direct3D 8 program sets through the guest routines is what its
 * getters read back, on every call, from either of two threads whose calls
 * share the device's command ring.
 *
 * The program makes a device and a second thread, and each thread loops:
 * the main thread sets three render states, two stage states on stages 3 and
 * 7 and two transforms, then reads every one back; the
 * second thread does the same with a render state and a stage state of its
 * own. Every value changes from one iteration to the next, so a record made
 * late, or lost, reads back the value before. The loops run long enough for the routines to be
 * translated, and the two threads' setters interleave with each other's
 * entries into the host. The program reports each thread's mismatches.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';
import { IDIRECT3DDEVICE8_SLOTS } from './layers/graphics/seam/vtables.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {number} value */
const f32 = value=>u32(new Uint32Array(new Float32Array([value]).buffer)[0]);

/** Iterations of each thread. */
const MAIN = 3000;
const WORKER = 3000;

/** @param {string} name */
const slot = name=>3 + IDIRECT3DDEVICE8_SLOTS.findIndex(([entry])=>entry === name);

function buildShadowExe(){
    const D3DRS_ALPHAREF = 24;
    const D3DRS_FOGCOLOR = 34;
    const D3DRS_TEXTUREFACTOR = 60;
    const D3DRS_COLORWRITEENABLE = 168;
    const D3DTSS_TEXCOORDINDEX = 11;
    const D3DTSS_TEXTURETRANSFORMFLAGS = 24;
    const D3DTS_TEXTURE7 = 23;
    const D3DTS_WORLD = 256;
    const WORKER_OFFSET = 0x800;

    return buildExe({
        imports: {
            'USER32.dll': ['RegisterClassA', 'CreateWindowExA', 'DefWindowProcA'],
            'D3D8.dll': ['Direct3DCreate8'],
            'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'VirtualAlloc',
                'GetStdHandle', 'WriteFile', 'ExitProcess'],
        },
        codeSize: 0xc00,
        data: {
            className: [...Buffer.from('BottlifyShadow'), 0],
            wndclass: new Array(40).fill(0),
            present: [
                ...u32(64), ...u32(64), ...u32(22), ...u32(1), ...u32(0), ...u32(1),
                ...u32(0), ...u32(1), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
            ],
            device: u32(0),
            // A page of the program's own for the answers and the report, apart from
            // the image's section, which holds the code: a host write there is a
            // write into code.
            page: u32(0),
            thread: u32(0),
            written: u32(0),
            matrices: [
                ...[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1].flatMap(f32),
                ...[0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1].flatMap(f32),
            ],
        },
        code: ({ iat, at, code })=>{
            /** @param {number} value */
            const push = value=>[0x68, ...u32(value)];
            /** A method of the interface in ESI, its arguments right to left. */
            const method = (/** @type {string} */ name, /** @type {number[][]} */ args)=>[
                ...args.slice().reverse().flat(),
                0x56, 0x8b, 0x06, 0xff, 0x90, ...u32(slot(name) * 4),
            ];
            /** EDI masked, pushed. @param {number[]} mask */
            const pushEdi = mask=>[0x89, 0xf8, ...mask, 0x50];
            const low8 = [0x25, ...u32(0xff)]; //            and eax, 0xff
            const low4 = [0x83, 0xe0, 0x0f]; //              and eax, 15
            const low2 = [0x83, 0xe0, 0x03]; //              and eax, 3
            /** The answer slot at EBX + offset, pushed. @param {number} offset */
            const pushAnswer = offset=>[0x8d, 0x43, offset, 0x50]; // lea eax, [ebx+o]; push eax
            /**
             * EDI masked against the dword at EBX + offset; a mismatch counts at EBX + counter.
             *
             * @param {number[]} mask @param {number} offset @param {number} counter
             */
            const check = (mask, offset, counter)=>[
                0x89, 0xf8, ...mask, //                     mov eax, edi; and eax, mask
                0x3b, 0x43, offset, //                      cmp eax, [ebx+offset]
                0x74, 0x03, //                              je +3
                0xff, 0x43, counter, //                     inc dword [ebx+counter]
            ];
            /** One of the two matrices, by bit `shift` of EDI, in EAX. @param {number} shift */
            const matrixOf = shift=>[
                0x89, 0xf8, //                              mov eax, edi
                ...(shift ? [0xc1, 0xe8, shift] : []), //    shr eax, shift
                0x83, 0xe0, 0x01, 0xc1, 0xe0, 0x06, //       and eax, 1; shl eax, 6
                0x05, ...u32(at('matrices')), //            add eax, matrices
            ];
            /**
             * A float of the matrix the program set against the one read back.
             *
             * @param {number} shift @param {number} word
             */
            const checkMatrix = (shift, word)=>[
                ...matrixOf(shift),
                0x8b, 0x40, word * 4, //                    mov eax, [eax+word*4]
                0x3b, 0x43, 16 + word * 4, //               cmp eax, [ebx+16+word*4]
                0x74, 0x03,
                0xff, 0x43, 0x00, //                        inc dword [ebx]
            ];
            const iteration = [
                ...method('SetRenderState', [push(D3DRS_ALPHAREF), pushEdi(low8)]),
                ...method('SetRenderState', [push(D3DRS_FOGCOLOR), [0x57]]),
                ...method('SetRenderState', [push(D3DRS_COLORWRITEENABLE), pushEdi(low4)]),
                ...method('SetTextureStageState', [push(3), push(D3DTSS_TEXCOORDINDEX),
                    pushEdi(low2)]),
                ...method('SetTextureStageState', [push(7), push(D3DTSS_TEXTURETRANSFORMFLAGS),
                    pushEdi(low2)]),
                ...method('SetTransform', [push(D3DTS_WORLD), [...matrixOf(0), 0x50]]),
                ...method('SetTransform', [push(D3DTS_TEXTURE7), [...matrixOf(1), 0x50]]),
                ...method('GetRenderState', [push(D3DRS_ALPHAREF), pushAnswer(8)]),
                ...check(low8, 8, 0),
                ...method('GetRenderState', [push(D3DRS_FOGCOLOR), pushAnswer(8)]),
                ...check([], 8, 0),
                ...method('GetRenderState', [push(D3DRS_COLORWRITEENABLE), pushAnswer(8)]),
                ...check(low4, 8, 0),
                ...method('GetTextureStageState', [push(3), push(D3DTSS_TEXCOORDINDEX),
                    pushAnswer(8)]),
                ...check(low2, 8, 0),
                ...method('GetTextureStageState', [push(7), push(D3DTSS_TEXTURETRANSFORMFLAGS),
                    pushAnswer(8)]),
                ...check(low2, 8, 0),
                ...method('GetTransform', [push(D3DTS_WORLD), pushAnswer(16)]),
                ...checkMatrix(0, 12),
                ...method('GetTransform', [push(D3DTS_TEXTURE7), pushAnswer(16)]),
                ...checkMatrix(1, 1),
                0x4f, //                                    dec edi
            ];
            const loop = [...iteration, 0x0f, 0x85, ...u32(-(iteration.length + 6))];
            const main = [
                0xa1, ...u32(iat('DefWindowProcA')), 0xa3, ...u32(at('wndclass') + 4),
                0xc7, 0x05, ...u32(at('wndclass') + 36), ...u32(at('className')),
                ...push(at('wndclass')), 0xff, 0x15, ...u32(iat('RegisterClassA')),
                ...push(0), ...push(0), ...push(0), ...push(0), ...push(64), ...push(64),
                ...push(0), ...push(0), ...push(0x00cf0000), ...push(at('className')),
                ...push(at('className')), ...push(0), 0xff, 0x15, ...u32(iat('CreateWindowExA')),
                0xa3, ...u32(at('present') + 0x18), //      present.hDeviceWindow = hWnd
                0x89, 0xc7, //                              mov edi, eax
                ...push(220), 0xff, 0x15, ...u32(iat('Direct3DCreate8')),
                0x89, 0xc6, //                              mov esi, eax
                // CreateDevice(0, HAL, hWnd, SOFTWARE_VERTEXPROCESSING, &present, &device)
                ...push(at('device')), ...push(at('present')), ...push(0x20), 0x57, ...push(1),
                ...push(0), 0x56, 0x8b, 0x06, 0xff, 0x90, ...u32((3 + 12) * 4),
                0x8b, 0x35, ...u32(at('device')), //        mov esi, [device]
                // VirtualAlloc(NULL, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE)
                ...push(4), ...push(0x3000), ...push(0x1000), ...push(0),
                0xff, 0x15, ...u32(iat('VirtualAlloc')),
                0xa3, ...u32(at('page')), 0x89, 0xc3, //    mov [page], eax; mov ebx, eax
                // CreateThread(NULL, 0, worker, NULL, 0, NULL)
                ...push(0), ...push(0), ...push(0), ...push(code(WORKER_OFFSET)), ...push(0),
                ...push(0), 0xff, 0x15, ...u32(iat('CreateThread')),
                0xa3, ...u32(at('thread')),
                0xbf, ...u32(MAIN), //                      mov edi, MAIN
                ...loop,
                // WaitForSingleObject(thread, INFINITE)
                ...push(0xffffffff), 0xff, 0x35, ...u32(at('thread')),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),
                // WriteFile(GetStdHandle(-11), page, 8, &written, NULL): the two counts
                ...push(0xfffffff5), 0xff, 0x15, ...u32(iat('GetStdHandle')),
                ...push(0), ...push(at('written')), ...push(8), 0x53, 0x50,
                0xff, 0x15, ...u32(iat('WriteFile')),
                ...push(0), 0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
            const workerIteration = [
                ...method('SetRenderState', [push(D3DRS_TEXTUREFACTOR), [0x57]]),
                ...method('SetTextureStageState', [push(5), push(D3DTSS_TEXCOORDINDEX),
                    pushEdi(low2)]),
                ...method('GetRenderState', [push(D3DRS_TEXTUREFACTOR), pushAnswer(12)]),
                ...check([], 12, 4),
                ...method('GetTextureStageState', [push(5), push(D3DTSS_TEXCOORDINDEX),
                    pushAnswer(12)]),
                ...check(low2, 12, 4),
                0x4f,
            ];
            const worker = [
                0x53, 0x56, 0x57, //                        push ebx; push esi; push edi
                0x8b, 0x35, ...u32(at('device')),
                0x8b, 0x1d, ...u32(at('page')),
                0xbf, ...u32(WORKER), //                    mov edi, WORKER
                ...workerIteration, 0x0f, 0x85, ...u32(-(workerIteration.length + 6)),
                0x5f, 0x5e, 0x5b, 0x31, 0xc0, 0xc2, 0x04, 0x00, // pop; xor eax, eax; ret 4
            ];
            if (main.length > WORKER_OFFSET)
            {
                throw new Error(`main body is ${main.length} bytes, past the worker`);
            }
            return [...main, ...new Array(WORKER_OFFSET - main.length).fill(0xcc), ...worker];
        },
    });
}

async function run(){
    const gpu = createFakeDevice();
    const gpuDevice = /** @type {any} */ (gpu.device);
    gpuDevice.features = new Set();
    gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor });
    const app = await createApp({
        executable: buildShadowExe(),
        device: {
            device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
            adapter: { vendor: 'fake', architecture: '', description: 'a stand-in' },
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
        const code = await app.run({ timeoutMs: 50000 });
        const dword = (/** @type {number} */ at)=>(bytes[at] | bytes[at + 1] << 8
            | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;
        const graphics = app.diagnostics().find((/** @type {any} */ layer)=>
            layer.name === 'graphics');
        return {
            code,
            main: bytes.length >= 8 ? dword(0) : null,
            worker: bytes.length >= 8 ? dword(4) : null,
            shadow: graphics?.metrics?.shadow ?? null,
        };
    }
    finally
    {
        await app.dispose();
    }
}

test(`what a Direct3D 8 program sets in the guest is what it reads back`,
    { timeout: 60000 }, async t=>{
        const result = await run();
        t.diagnostic(JSON.stringify(result));
        assert.equal(result.code, 0);
        assert.equal(result.main, 0, 'every value the main thread set read back as set');
        assert.equal(result.worker, 0, 'and every value the second thread set');
        const { shadow } = result;
        assert.ok(shadow, 'the device kept its state in the guest');
        // The setters of both threads went through the command ring, the two
        // threads' records interleaved: the host made those before its last
        // entry, and the rest wait in the ring -- the getters answer in the
        // guest, and nothing drains the ring before the program exits.
        const setters = MAIN * (3 + 2 + 2) + WORKER * (1 + 1);
        const ringed = shadow.commandCalls + shadow.commandsQueued;
        assert.ok(ringed >= setters * 0.9 && ringed <= setters,
            `${shadow.commandCalls} made and ${shadow.commandsQueued} held of ${setters}`
            + ' through the ring');
        assert.deepEqual(shadow.refused, 0);
    });
