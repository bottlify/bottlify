/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A library linked at 0x20000000 with its relocations stripped -- an engine
 * DLL of a 2006 game is one -- loads at that base, which in a new process on
 * Windows is free and here lies in the heap's arena: the heap gives the span
 * up before the program starts, and goes on handing out the rest of the arena
 * around it. The program calls into the library, makes a quarter-gigabyte
 * allocation, and calls into it again; the library answers 42 both times.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const LIBRARY_BASE = 0x20000000;

function buildProgram(){
    return buildExe({
        imports: {
            'engine.dll': ['Value'],
            'KERNEL32.dll': ['GetProcessHeap', 'HeapAlloc', 'ExitProcess'],
        },
        codeSize: 0x80,
        code: ({ iat })=>{
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            return [
                ...call('Value'), //                            the library, before
                ...call('GetProcessHeap'),
                0x68, ...u32(0x10000000), 0x6a, 0x00, 0x50, //  dwBytes, flags, heap
                ...call('HeapAlloc'),
                0x85, 0xc0, 0x74, 0x0d, //                      test eax, eax; jz fail
                ...call('Value'), //                            the library, after
                0x50, ...call('ExitProcess'),
                0x6a, 0x01, ...call('ExitProcess'), //          fail: no room
            ];
        },
    });
}

/** A library with no relocations at LIBRARY_BASE, exporting Value: 42. */
function buildLibrary(){
    const file = buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        exports: [{ name: 'Value', offset: 8 }],
        code: ()=>[
            0xb8, ...u32(1), 0xc2, 0x0c, 0x00, //              DllMain: mov eax, 1; ret 12
            0xb8, ...u32(42), 0xc3, //                         Value: mov eax, 42; ret
        ],
    });
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const coff = view.getUint32(0x3c, true) + 4;
    view.setUint16(coff + 18, view.getUint16(coff + 18, true) | 0x2000, true);
    view.setUint32(coff + 20 + 28, LIBRARY_BASE, true);
    return file;
}

test('a library that cannot move loads at a base the heap\'s arena covers, and the heap goes on',
    { timeout: 60000 }, async t=>{
        const app = await createApp({
            executable: buildProgram(),
            imagePath: 'C:\\App\\Fixed.exe',
            files: [{ path: 'C:\\App\\engine.dll', bytes: buildLibrary() }],
        });
        t.after(()=>app.dispose());

        assert.equal(await app.run({ timeoutMs: 40000 }), 42);
    });
