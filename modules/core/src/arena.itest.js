/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a process needs before it starts -- thread-local blocks, the stub that
 * attaches its libraries -- goes where nothing else is and below the thread
 * stacks, however close to them the libraries the program brought reach. A
 * library here that cannot move ends half a megabyte short of the stacks, and
 * the program then starts a thread, whose stack is the first in the pool.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, spaceAbove } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** Where the library asks to be, and how far it reaches. */
const LIBRARY_BASE = 0x07000000;

function buildProgram(){
    return buildExe({
        imports: {
            'big.dll': ['Nothing'],
            'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'ExitProcess'],
        },
        codeSize: 0x80,
        code: ({ iat, code })=>{
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            /** @param {number} start */
            const main = start=>[
                ...call('Nothing'),
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, //          id, flags, parameter
                0x68, ...u32(start), 0x6a, 0x00, 0x6a, 0x00, // start, stack, attributes
                ...call('CreateThread'),
                0x6a, 0xff, 0x50, ...call('WaitForSingleObject'),
                0x6a, 0x07, ...call('ExitProcess'),
            ];
            const thread = [0x31, 0xc0, 0xc2, 0x04, 0x00]; //   xor eax, eax; ret 4
            const length = main(0).length;
            return [...main(code(length)), ...thread];
        },
    });
}

/**
 * A library with no relocations, at LIBRARY_BASE and large enough to end half
 * a megabyte below the stack pool.
 *
 * @param {number} stackPool
 */
function buildLibrary(stackPool){
    const file = buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        exports: [{ name: 'Nothing', offset: 8 }],
        code: ()=>[
            0xb8, ...u32(1), 0xc2, 0x0c, 0x00, //              DllMain: mov eax, 1; ret 12
            0x90, //                                           nop
            0xc3, //                                           Nothing: ret
        ],
    });
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const coff = view.getUint32(0x3c, true) + 4;
    view.setUint16(coff + 18, view.getUint16(coff + 18, true) | 0x2000, true);
    view.setUint32(coff + 20 + 28, LIBRARY_BASE, true);
    view.setUint32(coff + 20 + 56, stackPool - 0x80000 - LIBRARY_BASE, true);
    return file;
}

test('the startup arena stays below the thread stacks when the libraries reach them',
    { timeout: 60000 }, async t=>{
        const executable = buildProgram();
        const { stackPoolBase } = spaceAbove(0x400000 + 0x3000);
        const app = await createApp({
            executable,
            imagePath: 'C:\\App\\Arena.exe',
            files: [{ path: 'C:\\App\\big.dll', bytes: buildLibrary(stackPoolBase) }],
        });
        t.after(()=>app.dispose());

        assert.equal(await app.run({ timeoutMs: 40000 }), 7);
    });
