/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A library loaded at run time counts its loads, and the last FreeLibrary
 * tells its DllMain and unloads it: GetModuleHandle then finds nothing, as
 * Wine's loader test has it. The library records each reason its DllMain is
 * called with into the program's own data, and the program checks one
 * property per bit of its exit code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * A fixture image given a relocation directory -- one empty block -- so that
 * it can be mapped anywhere; its only absolute address is the program's.
 *
 * @param {Uint8Array} file
 */
function movable(file){
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const optional = view.getUint32(0x3c, true) + 4 + 20;
    view.setUint32(optional + 96 + 5 * 8, 0x1020, true);
    view.setUint32(optional + 96 + 5 * 8 + 4, 8, true);
    view.setUint32(0x220, 0x1000, true);
    view.setUint32(0x224, 8, true);
    return file;
}

/**
 * Marks a fixture image as a DLL: only a library's DllMain is run.
 *
 * @param {Uint8Array} file
 */
function library(file){
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const characteristics = view.getUint32(0x3c, true) + 4 + 18;
    view.setUint16(characteristics, view.getUint16(characteristics, true) | 0x2000, true);
    return file;
}

/**
 * Exit code bits: loaded (1), loaded again as the same module (2), still
 * there after one of two frees (4), attached once and not yet detached (8),
 * the last free answered TRUE (16), detached (32), and gone (64).
 *
 * @returns {{ executable: Uint8Array, reasons: number }}
 */
function buildProgram(){
    let reasons = 0;
    const executable = buildExe({
        imports: { 'KERNEL32.dll': ['LoadLibraryA', 'FreeLibrary', 'GetModuleHandleA',
            'ExitProcess'] },
        data: { name: [...'probe.dll'].map(c=>c.charCodeAt(0)).concat(0), reasons: [0, 0, 0, 0] },
        codeSize: 0x100,
        code: ({ iat, at })=>{
            reasons = at('reasons');
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            const name = [0x68, ...u32(at('name'))];
            /** @param {number} value @param {number} bit */
            const reasonsAre = (value, bit)=>[
                0x83, 0x3d, ...u32(reasons), value, 0x75, 0x03, 0x80, 0xcb, bit,
            ];
            return [
                0x31, 0xdb, //                              xor ebx, ebx
                ...name, ...call('LoadLibraryA'),
                0x89, 0xc6, //                              mov esi, eax
                0x85, 0xc0, 0x74, 0x03, 0x80, 0xcb, 1, //   test eax, eax; jz; or bl, 1
                ...name, ...call('LoadLibraryA'),
                0x39, 0xf0, 0x75, 0x03, 0x80, 0xcb, 2, //   cmp eax, esi; jne; or bl, 2
                0x56, ...call('FreeLibrary'), //            push esi
                ...name, ...call('GetModuleHandleA'),
                0x85, 0xc0, 0x74, 0x03, 0x80, 0xcb, 4,
                ...reasonsAre(0x01, 8),
                0x56, ...call('FreeLibrary'),
                0x85, 0xc0, 0x74, 0x03, 0x80, 0xcb, 16,
                ...reasonsAre(0x10, 32),
                ...name, ...call('GetModuleHandleA'),
                0x85, 0xc0, 0x75, 0x03, 0x80, 0xcb, 64, //  test eax, eax; jnz; or bl, 64
                0x53, ...call('ExitProcess'), //            push ebx
            ];
        },
    });
    return { executable, reasons };
}

/**
 * DllMain(hinst, reason, reserved): shifts the reasons so far up a nibble,
 * puts this one below them, and answers TRUE.
 *
 * @param {number} reasons  Where the program keeps them.
 */
function buildProbe(reasons){
    return library(movable(buildExe({
        imports: { 'KERNEL32.dll': ['GetModuleHandleA'] },
        code: ()=>[
            0x8b, 0x44, 0x24, 0x08, //                     mov eax, [esp+8]    reason
            0x8b, 0x0d, ...u32(reasons), //                mov ecx, [reasons]
            0xc1, 0xe1, 0x04, //                           shl ecx, 4
            0x09, 0xc1, //                                 or ecx, eax
            0x89, 0x0d, ...u32(reasons), //                mov [reasons], ecx
            0xb8, ...u32(1), //                            mov eax, 1
            0xc2, 0x0c, 0x00, //                           ret 12
        ],
    })));
}

test('the last FreeLibrary tells DllMain and unloads the library', { timeout: 30000 }, async t=>{
    const { executable, reasons } = buildProgram();
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const app = await createApp({
        executable,
        imagePath: 'C:\\App\\Unload.exe',
        files: [{ path: 'C:\\App\\probe.dll', bytes: buildProbe(reasons) }],
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
    });
    t.after(()=>app.dispose());

    assert.equal(await app.run({ timeoutMs: 20000 }), 127);
});

test('an exception out of DllMain is taken by the loader, not by the program that freed it',
    { timeout: 30000 }, async t=>{
        // The program stands inside its own frame, whose handler exits with 99;
        // the library's DllMain raises #UD on DLL_PROCESS_DETACH. The loader's
        // frame between the two takes it, FreeLibrary returns, and the program
        // exits with 7.
        const executable = buildExe({
            imports: { 'KERNEL32.dll': ['LoadLibraryA', 'FreeLibrary', 'ExitProcess'] },
            data: { name: [...'probe.dll'].map(c=>c.charCodeAt(0)).concat(0) },
            codeSize: 0x60,
            code: ({ iat, at })=>[
                0xeb, 0x08, //                                jmp main
                0x6a, 99, 0xff, 0x15, ...u32(iat('ExitProcess')), // handler: exit 99
                0x68, ...u32(0x401002), //                    main: push handler
                0x64, 0xff, 0x35, 0, 0, 0, 0, //               push fs:[0]
                0x64, 0x89, 0x25, 0, 0, 0, 0, //               mov fs:[0], esp
                0x68, ...u32(at('name')), 0xff, 0x15, ...u32(iat('LoadLibraryA')),
                0x50, 0xff, 0x15, ...u32(iat('FreeLibrary')),
                0x6a, 7, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
        });
        const probe = library(movable(buildExe({
            imports: { 'KERNEL32.dll': ['GetModuleHandleA'] },
            code: ()=>[
                0x8b, 0x44, 0x24, 0x08, //                     mov eax, [esp+8]    reason
                0x85, 0xc0, 0x75, 0x02, //                     test eax, eax; jnz attach
                0x0f, 0x0b, //                                 ud2
                0xb8, ...u32(1), //                            attach: mov eax, 1
                0xc2, 0x0c, 0x00, //                           ret 12
            ],
        })));
        const app = await createApp({
            executable,
            imagePath: 'C:\\App\\Detach.exe',
            files: [{ path: 'C:\\App\\probe.dll', bytes: probe }],
            engine: 'cork',
        });
        t.after(()=>app.dispose());

        assert.equal(await app.run({ timeoutMs: 20000 }), 7);
    });
