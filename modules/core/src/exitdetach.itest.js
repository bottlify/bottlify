/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ExitProcess tells the libraries the process attached that it is ending: a
 * library the program imports has its DllMain called with DLL_PROCESS_ATTACH
 * before the program runs and with DLL_PROCESS_DETACH when the program calls
 * ExitProcess, before the process ends with the program's code. The library
 * writes each reason it is called with to standard output as a digit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** Where the library's one export starts; its DllMain fills the code before it. */
const TOUCH = 0x30;

/**
 * Makes a fixture image movable and marks it a DLL: a relocation directory of
 * one empty block, placed after the code, since its only absolute addresses
 * are the program's.
 *
 * @param {Uint8Array} file
 */
function movableLibrary(file){
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const coff = view.getUint32(0x3c, true) + 4;
    const optional = coff + 20;
    view.setUint16(coff + 18, view.getUint16(coff + 18, true) | 0x2000, true);
    view.setUint32(optional + 96 + 5 * 8, 0x1040, true);
    view.setUint32(optional + 96 + 5 * 8 + 4, 8, true);
    view.setUint32(0x240, 0x1000, true);
    view.setUint32(0x244, 8, true);
    return file;
}

test('ExitProcess sends DLL_PROCESS_DETACH to the libraries before the process ends',
    { timeout: 60000 }, async t=>{
        /** @type {{ getStdHandle: number, writeFile: number, digit: number,
         *     written: number }} */
        let program = { getStdHandle: 0, writeFile: 0, digit: 0, written: 0 };
        const executable = buildExe({
            imports: {
                'probe.dll': ['Touch'],
                'KERNEL32.dll': ['GetStdHandle', 'WriteFile', 'ExitProcess'],
            },
            data: { digit: [0, 0, 0, 0], written: [0, 0, 0, 0] },
            code: ({ iat, at })=>{
                program = {
                    getStdHandle: iat('GetStdHandle'), writeFile: iat('WriteFile'),
                    digit: at('digit'), written: at('written'),
                };
                return [
                    0xff, 0x15, ...u32(iat('Touch')), //       call [Touch]
                    0x6a, 0x05, //                             push 5
                    0xff, 0x15, ...u32(iat('ExitProcess')), // call [ExitProcess]
                ];
            },
        });
        // DllMain(hinst, reason, reserved) writes '0' + reason through the
        // program's own import slots, which are the only addresses it has.
        const library = movableLibrary(buildExe({
            imports: { 'KERNEL32.dll': ['GetStdHandle'] },
            exports: [{ name: 'Touch', offset: TOUCH }],
            codeSize: 0x60,
            code: ()=>{
                const main = [
                    0x8b, 0x44, 0x24, 0x08, //                     mov eax, [esp+8]
                    0x04, 0x30, //                                 add al, '0'
                    0xa2, ...u32(program.digit), //                mov [digit], al
                    0x6a, 0xf5, //                                 push STD_OUTPUT_HANDLE
                    0xff, 0x15, ...u32(program.getStdHandle), //   call [GetStdHandle]
                    0x6a, 0x00, //                                 push NULL
                    0x68, ...u32(program.written), //              push &written
                    0x6a, 0x01, //                                 push 1
                    0x68, ...u32(program.digit), //                push digit
                    0x50, //                                       push eax
                    0xff, 0x15, ...u32(program.writeFile), //      call [WriteFile]
                    0xb8, ...u32(1), //                            mov eax, TRUE
                    0xc2, 0x0c, 0x00, //                           ret 12
                ];
                assert.equal(main.length, TOUCH);
                return [...main, 0xc3]; //                         Touch: ret
            },
        }));

        const app = await createApp({
            executable,
            imagePath: 'C:\\App\\Detach.exe',
            files: [{ path: 'C:\\App\\probe.dll', bytes: library }],
        });
        t.after(()=>app.dispose());
        let output = '';
        app.on('output', (/** @type {any} */ payload)=>{
            output += payload.text;
        });

        assert.equal(await app.run({ timeoutMs: 40000 }), 5);
        assert.equal(output, '10', 'attached before the program ran, detached as it ended');
    });
