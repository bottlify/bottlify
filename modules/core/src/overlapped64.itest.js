/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A 64-bit program's OVERLAPPED, whose Internal and InternalHigh are eight
 * bytes each, so that its Offset is at 16 and its hEvent at 24: an overlapped
 * read at an offset reads from there, and its result is written where the
 * program reads it. Taken at the 32-bit offsets, the position was
 * InternalHigh's zero and every overlapped read came from the file's start.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import { overlappedLayout } from './layers/win32/common/overlapped.js';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {string} text */
const ascii = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);

test('OVERLAPPED is laid out by the width of the process', ()=>{
    assert.deepEqual(overlappedLayout(4), { internal: 0, internalHigh: 4, offset: 8,
        offsetHigh: 12, event: 16, word: 4 });
    assert.deepEqual(overlappedLayout(8), { internal: 0, internalHigh: 8, offset: 16,
        offsetHigh: 20, event: 24, word: 8 });
});

test('a 64-bit program reads at the offset its OVERLAPPED names and is told how much',
    { timeout: 60000 }, async t=>{
        /** @type {Record<string, number>} */
        const where = {};
        const program = buildExe({
            bits: 64, codeSize: 0x200,
            imports: { 'KERNEL32.dll': ['CreateFileA', 'WriteFile', 'CloseHandle', 'ReadFile',
                'GetOverlappedResult', 'ExitProcess'] },
            data: {
                path: ascii('C:\\overlapped.bin'), text: ascii('0123456789abcdef'),
                handle: new Array(8).fill(0), count: new Array(8).fill(0),
                // Internal, InternalHigh, Offset 8, OffsetHigh, hEvent
                overlapped: [...new Array(8).fill(0x55), ...new Array(8).fill(0x55),
                    ...u32(8), ...u32(0), ...new Array(8).fill(0)],
                buffer: new Array(8).fill(0), transferred: new Array(8).fill(0),
            },
            code: ({ iat, at, code })=>{
                for (const name of ['buffer', 'transferred', 'overlapped'])
                {
                    where[name] = at(name);
                }
                /** @type {number[]} */
                const bytes = [];
                /** @param {number[]} op @param {number} to */
                const rip = (op, to)=>bytes.push(...op,
                    ...u32(to - (code(bytes.length) + op.length + 4)));
                const call = (/** @type {string} */ name)=>rip([0xff, 0x15], iat(name));
                /** mov qword [rsp+at], value @param {number} offset @param {number} value */
                const stack = (offset, value)=>bytes.push(0x48, 0xc7, 0x44, 0x24, offset,
                    ...u32(value));
                /** @param {number} access @param {number} share @param {number} disposition
                 *  @param {number} flags */
                const open = (access, share, disposition, flags)=>{
                    rip([0x48, 0x8d, 0x0d], at('path')); //               lea rcx, [path]
                    bytes.push(0xba, ...u32(access), 0x41, 0xb8, ...u32(share));
                    bytes.push(0x45, 0x31, 0xc9); //                       xor r9d, r9d
                    stack(0x20, disposition);
                    stack(0x28, flags);
                    stack(0x30, 0);
                    call('CreateFileA');
                    rip([0x48, 0x89, 0x05], at('handle')); //             mov [handle], rax
                };
                const handle = ()=>rip([0x48, 0x8b, 0x0d], at('handle')); // mov rcx, [handle]
                bytes.push(0x48, 0x83, 0xec, 0x48); //                     sub rsp, 72
                open(0xc0000000, 0, 2, 0x80); //                            CREATE_ALWAYS
                handle();
                rip([0x48, 0x8d, 0x15], at('text'));
                bytes.push(0x41, 0xb8, ...u32(16));
                rip([0x4c, 0x8d, 0x0d], at('count'));
                stack(0x20, 0);
                call('WriteFile');
                handle();
                call('CloseHandle');
                open(0x80000000, 1, 3, 0x40000080); //                     OPEN_EXISTING, overlapped
                handle();
                rip([0x48, 0x8d, 0x15], at('buffer'));
                bytes.push(0x41, 0xb8, ...u32(4));
                rip([0x4c, 0x8d, 0x0d], at('count'));
                rip([0x48, 0x8d, 0x05], at('overlapped')); //               lea rax, [overlapped]
                bytes.push(0x48, 0x89, 0x44, 0x24, 0x20); //               mov [rsp+32], rax
                call('ReadFile');
                handle();
                rip([0x48, 0x8d, 0x15], at('overlapped'));
                rip([0x4c, 0x8d, 0x05], at('transferred'));
                bytes.push(0x41, 0xb9, ...u32(1)); //                      mov r9d, TRUE
                call('GetOverlappedResult');
                bytes.push(0x31, 0xc9);
                call('ExitProcess');
                return bytes;
            },
        });
        const app = await createApp({ executable: program });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 30000 }), 0);
        const read = (/** @type {string} */ name, /** @type {number} */ length)=>
            new DataView(app.debug.read(where[name], length).slice().buffer);
        assert.equal(String.fromCharCode(...app.debug.read(where.buffer, 4)), '89ab',
            'the four bytes at offset 8');
        assert.equal(read('transferred', 4).getUint32(0, true), 4, 'GetOverlappedResult');
        const overlapped = read('overlapped', 16);
        assert.equal(overlapped.getBigUint64(0, true), 0n, 'Internal: success, whole');
        assert.equal(overlapped.getBigUint64(8, true), 4n, 'InternalHigh: four bytes, whole');
    });
