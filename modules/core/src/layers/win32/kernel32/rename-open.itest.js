/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A file renamed while open is still the file its handle names, as on
 * Windows: a program writes a file, moves the folder it is in (or the file
 * itself) and asks the handle the file's size. An NGen worker so installs
 * the native image it wrote, and gave up when the size read zero.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../app.js';
import { assemble, buildExe } from '../../../../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[0, 8, 16, 24].map(at=>(value >>> at) & 0xff);
/** @param {string} text */
const ansi = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

const GENERIC_READ_WRITE = 0xc0000000;
const SHARE_READ_DELETE = 0x5;
const CREATE_ALWAYS = 2;
/** The exit code when the move itself is refused. */
const REFUSED = 0xdead;

/**
 * CreateDirectoryA(from), CreateFileA(from\file), WriteFile(100 bytes),
 * MoveFileA(moved, to), GetFileSize(handle): the exit code, REFUSED when the move was.
 *
 * @param {string} moved  What is renamed: the folder or the file.
 * @param {string} to
 */
const program = (moved, to)=>buildExe({
    imports: { 'KERNEL32.dll': ['CreateDirectoryA', 'CreateFileA', 'WriteFile', 'MoveFileA',
        'GetFileSize', 'ExitProcess'] },
    data: { folder: ansi('C:\\Temp'), file: ansi('C:\\Temp\\image.tmp'), moved: ansi(moved),
        to: ansi(to), bytes: new Array(100).fill(9), written: u32(0), handle: u32(0) },
    codeSize: 0x80,
    code: ({ iat, at })=>assemble([
        0x6a, 0, 0x68, ...u32(at('folder')), 0xff, 0x15, ...u32(iat('CreateDirectoryA')),
        0x6a, 0, 0x68, ...u32(0x80), 0x6a, CREATE_ALWAYS, 0x6a, 0, 0x6a, SHARE_READ_DELETE,
        0x68, ...u32(GENERIC_READ_WRITE), 0x68, ...u32(at('file')),
        0xff, 0x15, ...u32(iat('CreateFileA')),
        0xa3, ...u32(at('handle')),
        0x6a, 0, 0x68, ...u32(at('written')), 0x6a, 100, 0x68, ...u32(at('bytes')),
        0xff, 0x35, ...u32(at('handle')), 0xff, 0x15, ...u32(iat('WriteFile')),
        0x68, ...u32(at('to')), 0x68, ...u32(at('moved')), 0xff, 0x15, ...u32(iat('MoveFileA')),
        0xb9, ...u32(REFUSED), 0x85, 0xc0, 0x0f, 0x44, 0xc1, // mov ecx, REFUSED; cmovz eax, ecx
        { jump: 'jz', to: 'out' },
        0x6a, 0, 0xff, 0x35, ...u32(at('handle')), 0xff, 0x15, ...u32(iat('GetFileSize')),
        { label: 'out' },
        0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
    ]),
});

for (const [what, moved, to] of [
    ['the file', 'C:\\Temp\\image.tmp', 'C:\\image.dll'],
    ['its folder', 'C:\\Temp', 'C:\\Cache'],
])
{
    test(`an open file keeps its size through its handle when ${what} is renamed`,
        { timeout: 60_000 }, async()=>{
            const app = await createApp({ executable: program(moved, to),
                imagePath: 'C:\\rename.exe' });
            try
            {
                assert.equal(await app.run({ timeoutMs: 30_000 }), 100);
            }
            finally
            {
                await app.dispose();
            }
        });
}
