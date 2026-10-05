/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A Direct3D 9 program built by `make-pe.mjs`, for the tests that play its
 * device on the graphics worker: a 64x32 window and a device on it, a 64x64
 * texture locked, filled, unlocked, drawn with and presented once a frame,
 * then ExitProcess(0).
 *
 * Dev tooling, like `make-pe.mjs`: never imported by a package.
 */

import { IDIRECT3DDEVICE9_SLOTS, IDIRECT3DTEXTURE9_SLOTS } from
    '../modules/core/src/layers/graphics/d3d9/interfaces.js';
import { IDIRECT3D9_SLOTS } from '../modules/core/src/layers/graphics/seam/vtables.js';
import { buildExe } from './make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {[string, number][]} slots @param {string} name */
const slotIn = (slots, name)=>3 + slots.findIndex(([entry])=>entry === name);

/** @param {number} frames  how many it presents */
export function texturedFrames(frames){
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
            frames: u32(frames),
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
