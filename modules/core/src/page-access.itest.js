/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A page the program reserved and did not commit faults when it is touched, and
 * the access violation says what address and whether it wrote: a program that
 * pages its own data in -- reserving a span, committing each page in its
 * exception handler as it is touched, and going on -- runs as on Windows.
 *
 * The program reserves 64 KiB PAGE_NOACCESS, installs a frame handler, and reads
 * a dword in the middle of it; the handler commits the page the record names,
 * writes a marker at the address and continues the read, which then finds the
 * marker. A second read of the same page, now committed, faults no more. Exit:
 * 1 the read found the marker, 2 the handler was called once, 4 it was told a
 * read at the address read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const OFFSET = 0x5234;
const MARKER = 0x12345678;
const HANDLER_AT = 0x100;

function buildProgram(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['VirtualAlloc', 'ExitProcess'] },
        codeSize: 0x200,
        data: { base: u32(0), calls: u32(0), told: u32(0), kind: u32(0xff) },
        code: ({ iat, at, code })=>{
            const main = [
                0x68, ...u32(code(HANDLER_AT)), //          push handler
                0x64, 0xff, 0x35, ...u32(0), //             push fs:[0]
                0x64, 0x89, 0x25, ...u32(0), //             mov fs:[0], esp
                // VirtualAlloc(NULL, 64 KiB, MEM_RESERVE, PAGE_NOACCESS)
                0x6a, 0x01, 0x68, ...u32(0x2000), 0x68, ...u32(0x10000), 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('VirtualAlloc')),
                0xa3, ...u32(at('base')), //                mov [base], eax
                0x8b, 0x80, ...u32(OFFSET), //              mov eax, [eax+OFFSET]
                0x8b, 0x0d, ...u32(at('base')), //          mov ecx, [base]
                0x8b, 0x89, ...u32(OFFSET + 4), //          mov ecx, [ecx+OFFSET+4]  (same page)
                0x31, 0xdb, //                              xor ebx, ebx
                0x3d, ...u32(MARKER), 0x75, 0x03, 0x83, 0xcb, 0x01, // cmp eax, MARKER
                0x83, 0x3d, ...u32(at('calls')), 0x01, 0x75, 0x03, 0x83, 0xcb, 0x02,
                0xa1, ...u32(at('base')), 0x05, ...u32(OFFSET), //  mov eax, [base]; add eax, OFFSET
                0x3b, 0x05, ...u32(at('told')), 0x75, 0x0c, //       cmp eax, [told]; jne +12
                0x83, 0x3d, ...u32(at('kind')), 0x00, 0x75, 0x03, //  cmp dword [kind], 0; jne +3
                0x83, 0xcb, 0x04,
                0x53, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
            // EXCEPTION_DISPOSITION handler(record, frame, context, dispatcher), cdecl
            const handler = [
                0xff, 0x05, ...u32(at('calls')), //         inc dword [calls]
                0x8b, 0x44, 0x24, 0x04, //                  mov eax, [esp+4]  the record
                0x8b, 0x48, 0x14, //                        mov ecx, [eax+20]  information[0]
                0x89, 0x0d, ...u32(at('kind')), //          mov [kind], ecx
                0x8b, 0x40, 0x18, //                        mov eax, [eax+24]  information[1]
                0xa3, ...u32(at('told')), //                mov [told], eax
                0x25, ...u32(0xfffff000), //                and eax, ~0xfff
                // VirtualAlloc(page, 4096, MEM_COMMIT, PAGE_READWRITE)
                0x6a, 0x04, 0x68, ...u32(0x1000), 0x68, ...u32(0x1000), 0x50,
                0xff, 0x15, ...u32(iat('VirtualAlloc')),
                0x8b, 0x0d, ...u32(at('told')), //          mov ecx, [told]
                0xc7, 0x01, ...u32(MARKER), //              mov dword [ecx], MARKER
                0x31, 0xc0, 0xc3, //                        xor eax, eax  (continue); ret
            ];
            return [...main, ...new Array(HANDLER_AT - main.length).fill(0xcc), ...handler];
        },
    });
}

/** @param {Record<string, unknown>} config */
async function run(config){
    const app = await createApp({ executable: buildProgram(), cork: { config } });
    try
    {
        return await app.run({ timeoutMs: 30_000 });
    }
    finally
    {
        await app.dispose();
    }
}

test('a reserved page faults, and the handler that commits it goes on -- with nothing asked',
    { timeout: 90_000 }, async()=>{
        // The default: a program that commits pages in its own handler as it
        // touches them needs no setting of its own to run -- its first fault
        // has translated reads tested from then on.
        assert.equal(await run({}), 7, 'interpreted and translated alike');
        assert.equal(await run({ checkReads: true }), 7, 'reads tested from the start');
        assert.equal(await run({ translate: false }), 7, 'interpreted only');
    });
